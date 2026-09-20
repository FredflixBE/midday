import { transformCustomerToContent } from "@midday/invoice/utils";
import {
  acceptanceProblem,
  type Block,
  blockSchema,
  initialQuoteContent,
  isExpired,
  nextQuoteNumber,
  type PricingResult,
  type ProductRates,
  parseQuoteContent,
  priceVersion,
  type QuoteContent,
  type QuoteKind,
  quoteHeadline,
  quoteNumberSequence,
} from "@midday/quote";
import type {
  QuoteLanguage as PdfLanguage,
  QuotePdfInput,
} from "@midday/quote/pdf";
import { and, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  customerProductRates,
  customers,
  invoiceProducts,
  invoiceTemplates,
  quoteSettings,
  quotes,
  quoteVersions,
  teams,
} from "../schema";

/**
 * Quotes and their versions (FF-1609, docs/quotes.md §3.2–3.4).
 *
 * A quote is one customer, one subject and one number; a version is one
 * revision of it and the thing that is sent. The rules live here, so every
 * caller keeps them:
 *
 * - Only a draft is edited. A sent version is frozen: the client holds it.
 * - Revising copies the latest version into a new draft, version + 1, and a
 *   quote has at most one draft (the partial unique index holds that under
 *   concurrency too).
 * - Sending a version supersedes the previous sent one.
 * - Expired is read from the validity date on every read, never stored.
 *
 * Every content write is checked against `QuoteContent` from @midday/quote.
 */

/** A person's mistake, told apart from a failure so the API can say so. */
export class QuoteInputError extends Error {}

/**
 * Renders a version's PDF and stores it, giving back the path tokens it was
 * stored under (FF-1615). Rendering needs react-pdf and the bucket, neither
 * of which belongs here, so the caller passes it in and this module decides
 * when it runs: inside the transaction that marks a version sent, so that a
 * PDF which cannot be stored refuses the send rather than leaving a sent
 * version nobody can prove.
 *
 * It is what makes a sent version final. The content, the pricing, the
 * sender and the customer are frozen on the row, but the logo, the payment
 * details, the team's labels and the pictures in the text are all read as
 * they are at render time — so only a stored file is what the client holds.
 */
export type StoreQuotePdf = (input: QuotePdfInput) => Promise<string[]>;

export type QuoteLanguage = "nl" | "en";
export type QuoteMode = "estimate" | "firm";

export type QuoteSettings = {
  numberPrefix: string;
  defaultValidDays: number;
  hoursPerDay: number;
  defaultBlocks: Block[];
  labels: Record<string, Record<string, string>>;
};

const DEFAULT_SETTINGS: QuoteSettings = {
  numberPrefix: "OFF-",
  defaultValidDays: 30,
  hoursPerDay: 8,
  defaultBlocks: [],
  labels: {},
};

const labelsSchema = z.record(z.string(), z.record(z.string(), z.string()));

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function checkContent(value: unknown, kind: QuoteKind): QuoteContent {
  try {
    return parseQuoteContent(value, kind);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new QuoteInputError(
        error.issues.map((issue) => issue.message).join("; "),
      );
    }
    throw error;
  }
}

function checkBlocks(value: unknown): Block[] {
  const parsed = z.array(blockSchema).safeParse(value);
  if (!parsed.success) {
    throw new QuoteInputError("The default blocks are not quote blocks");
  }
  return parsed.data;
}

export async function getQuoteSettings(
  db: DatabaseOrTransaction,
  teamId: string,
): Promise<QuoteSettings> {
  const [row] = await db
    .select()
    .from(quoteSettings)
    .where(eq(quoteSettings.teamId, teamId));
  if (!row) return DEFAULT_SETTINGS;

  return {
    numberPrefix: row.numberPrefix,
    defaultValidDays: row.defaultValidDays,
    hoursPerDay: row.hoursPerDay,
    defaultBlocks: row.defaultBlocks as Block[],
    labels: row.labels as QuoteSettings["labels"],
  };
}

/** Saves what is given and keeps the rest. */
export async function updateQuoteSettings(
  db: Database,
  params: { teamId: string } & Partial<QuoteSettings>,
): Promise<QuoteSettings> {
  const { teamId, ...changes } = params;
  if (Object.values(changes).every((value) => value === undefined)) {
    return getQuoteSettings(db, teamId);
  }
  if (changes.defaultBlocks !== undefined) {
    changes.defaultBlocks = checkBlocks(changes.defaultBlocks);
  }
  if (
    changes.labels !== undefined &&
    !labelsSchema.safeParse(changes.labels).success
  ) {
    throw new QuoteInputError("Labels are text per language");
  }
  if (changes.numberPrefix !== undefined) {
    changes.numberPrefix = changes.numberPrefix.trim();
  }

  await db
    .insert(quoteSettings)
    .values({ ...DEFAULT_SETTINGS, ...changes, teamId })
    .onConflictDoUpdate({ target: quoteSettings.teamId, set: changes });

  return getQuoteSettings(db, teamId);
}

async function customerSnapshot(
  db: DatabaseOrTransaction,
  teamId: string,
  customerId: string,
) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.teamId, teamId)));
  return customer ? transformCustomerToContent(customer) : null;
}

/** The sender as the default invoice template has it. */
async function senderSnapshot(db: DatabaseOrTransaction, teamId: string) {
  const [template] = await db
    .select({ fromDetails: invoiceTemplates.fromDetails })
    .from(invoiceTemplates)
    .where(eq(invoiceTemplates.teamId, teamId))
    .orderBy(desc(invoiceTemplates.isDefault), invoiceTemplates.createdAt)
    .limit(1);
  return template?.fromDetails ?? null;
}

/**
 * The next number under the team's prefix, after the highest one in use under
 * that prefix — the approach `getNextInvoiceNumber` takes, except that the
 * sequence is read only past the prefix, so a prefix may end in digits and a
 * new prefix starts at 0001. Call it inside the transaction holding the
 * team's numbering lock.
 */
async function getNextQuoteNumber(
  tx: DatabaseOrTransaction,
  teamId: string,
  prefix: string,
) {
  const rest = sql`SUBSTRING(${quotes.quoteNumber} FROM ${prefix.length + 1}::int)`;
  const [highest] = await tx
    .select({ quoteNumber: quotes.quoteNumber })
    .from(quotes)
    .where(
      and(
        eq(quotes.teamId, teamId),
        sql`starts_with(${quotes.quoteNumber}, ${prefix})`,
        sql`${rest} ~ '^[0-9]+$'`,
      ),
    )
    .orderBy(sql`CAST(${rest} AS NUMERIC) DESC`)
    .limit(1);

  return nextQuoteNumber(
    prefix,
    highest ? quoteNumberSequence(highest.quoteNumber, prefix) : null,
  );
}

/**
 * A new quote and its first version, a draft: numbered, with the team's
 * default blocks copied in and the customer and sender snapshotted. Null when
 * the customer is not the team's.
 */
export async function createQuote(
  db: Database,
  params: {
    teamId: string;
    userId: string;
    customerId: string;
    title: string;
    kind: QuoteKind;
    language: QuoteLanguage;
    currency?: string;
    mode?: QuoteMode;
    today?: string;
  },
) {
  const title = params.title.trim();
  if (!title) throw new QuoteInputError("A quote needs a title");
  const today = params.today ?? todayUtc();

  const id = await db.transaction(async (tx) => {
    const customerDetails = await customerSnapshot(
      tx,
      params.teamId,
      params.customerId,
    );
    if (!customerDetails) return null;

    // One number at a time per team; the unique key is the backstop.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`quote_number:${params.teamId}`}))`,
    );

    const settings = await getQuoteSettings(tx, params.teamId);
    const [team] = await tx
      .select({ baseCurrency: teams.baseCurrency })
      .from(teams)
      .where(eq(teams.id, params.teamId));

    const [quote] = await tx
      .insert(quotes)
      .values({
        teamId: params.teamId,
        createdBy: params.userId,
        customerId: params.customerId,
        quoteNumber: await getNextQuoteNumber(
          tx,
          params.teamId,
          settings.numberPrefix,
        ),
        title,
        kind: params.kind,
        language: params.language,
        currency: params.currency ?? team?.baseCurrency ?? "EUR",
      })
      .returning({ id: quotes.id });

    const content = initialQuoteContent({
      defaultBlocks: settings.defaultBlocks,
      hoursPerDay: settings.hoursPerDay,
      newId: () => crypto.randomUUID(),
    });

    await tx.insert(quoteVersions).values({
      teamId: params.teamId,
      quoteId: quote!.id,
      version: 1,
      status: "draft",
      mode: params.mode ?? "estimate",
      issueDate: today,
      validUntil: addDays(today, settings.defaultValidDays),
      customerDetails,
      fromDetails: await senderSnapshot(tx, params.teamId),
      content: checkContent(content, params.kind),
    });

    return quote!.id;
  });

  return id ? getQuote(db, { id, teamId: params.teamId, today }) : null;
}

/** A quote with its versions, newest first, each saying whether it expired. */
export async function getQuote(
  db: DatabaseOrTransaction,
  params: { id: string; teamId: string; today?: string },
) {
  const [quote] = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, params.id), eq(quotes.teamId, params.teamId)));
  if (!quote) return null;

  const today = params.today ?? todayUtc();
  const versions = await db
    .select()
    .from(quoteVersions)
    .where(eq(quoteVersions.quoteId, quote.id))
    .orderBy(desc(quoteVersions.version));

  return {
    ...quote,
    versions: versions.map((version) => ({
      ...version,
      expired: isExpired(version, today),
    })),
  };
}

async function lockVersion(
  tx: DatabaseOrTransaction,
  teamId: string,
  versionId: string,
) {
  const [row] = await tx
    .select({ version: quoteVersions, quote: quotes })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(
      and(eq(quoteVersions.id, versionId), eq(quoteVersions.teamId, teamId)),
    )
    .for("update");
  return row ?? null;
}

/**
 * Edits a draft: its content, mode, dates and note, and the quote's header
 * (title, kind, language, customer), which the draft is what gets sent with.
 * Null when the version is not the team's.
 */
export async function updateQuoteDraft(
  db: Database,
  params: {
    teamId: string;
    versionId: string;
    title?: string;
    kind?: QuoteKind;
    language?: QuoteLanguage;
    customerId?: string;
    mode?: QuoteMode;
    issueDate?: string;
    validUntil?: string;
    content?: QuoteContent;
    internalNote?: string | null;
  },
) {
  const quoteId = await db.transaction(async (tx) => {
    const row = await lockVersion(tx, params.teamId, params.versionId);
    if (!row) return null;
    const { version, quote } = row;

    if (version.status !== "draft") {
      throw new QuoteInputError("Only a draft can be edited");
    }

    // The header lives on the quote, which every version shares. Once one
    // has been sent it is what the client holds, so it stays as sent.
    const headerChange =
      params.title !== undefined ||
      params.kind !== undefined ||
      params.language !== undefined ||
      params.customerId !== undefined;
    if (headerChange && version.version > 1) {
      throw new QuoteInputError(
        "A quote that has been sent keeps its customer, title, kind and language",
      );
    }

    const kind = params.kind ?? quote.kind;
    const content =
      params.content !== undefined || params.kind !== undefined
        ? checkContent(params.content ?? version.content, kind)
        : undefined;

    const issueDate = params.issueDate ?? version.issueDate;
    const validUntil = params.validUntil ?? version.validUntil;
    if (validUntil < issueDate) {
      throw new QuoteInputError("A quote cannot expire before it is issued");
    }

    let customerDetails: unknown;
    if (params.customerId !== undefined) {
      customerDetails = await customerSnapshot(
        tx,
        params.teamId,
        params.customerId,
      );
      if (!customerDetails) return null;
    }

    const title = params.title?.trim();
    if (title === "") throw new QuoteInputError("A quote needs a title");

    await tx
      .update(quotes)
      .set({
        title,
        kind: params.kind,
        language: params.language,
        customerId: params.customerId,
        updatedAt: sql`now()`,
      })
      .where(eq(quotes.id, quote.id));

    await tx
      .update(quoteVersions)
      .set({
        mode: params.mode,
        issueDate: params.issueDate,
        validUntil: params.validUntil,
        content,
        internalNote: params.internalNote,
        customerDetails,
        updatedAt: sql`now()`,
      })
      .where(eq(quoteVersions.id, version.id));

    return quote.id;
  });

  return quoteId ? getQuote(db, { id: quoteId, teamId: params.teamId }) : null;
}

/**
 * The latest version copied into a new draft, version + 1, issued today with
 * the team's default validity. Refused while the quote has a draft or once it
 * is accepted. Null when the quote is not the team's.
 */
export async function reviseQuote(
  db: Database,
  params: { teamId: string; quoteId: string; today?: string },
) {
  const today = params.today ?? todayUtc();

  const quoteId = await db.transaction(async (tx) => {
    const [quote] = await tx
      .select({ id: quotes.id })
      .from(quotes)
      .where(
        and(eq(quotes.id, params.quoteId), eq(quotes.teamId, params.teamId)),
      )
      .for("update");
    if (!quote) return null;

    const [latest] = await tx
      .select()
      .from(quoteVersions)
      .where(eq(quoteVersions.quoteId, quote.id))
      .orderBy(desc(quoteVersions.version))
      .limit(1);
    if (!latest) return null;

    if (latest.status === "draft") {
      throw new QuoteInputError("This quote already has a draft");
    }
    if (latest.status === "accepted") {
      throw new QuoteInputError("An accepted quote is not revised");
    }

    const settings = await getQuoteSettings(tx, params.teamId);
    await tx.insert(quoteVersions).values({
      teamId: params.teamId,
      quoteId: quote.id,
      version: latest.version + 1,
      status: "draft",
      mode: latest.mode,
      issueDate: today,
      validUntil: addDays(today, settings.defaultValidDays),
      customerDetails: latest.customerDetails,
      fromDetails: latest.fromDetails,
      content: latest.content,
      internalNote: latest.internalNote,
    });

    return quote.id;
  });

  return quoteId
    ? getQuote(db, { id: quoteId, teamId: params.teamId, today })
    : null;
}

/**
 * Marks a draft sent and freezes it with its pricing; the version sent before
 * it, if any, becomes superseded. The action a person takes is FF-1614's; the
 * rule is here. Null when the version is not the team's.
 *
 * With `storePdf`, the PDF is rendered and kept as part of the same
 * transaction (FF-1615): either the version is sent and its file is stored,
 * or neither happened.
 */
export async function markQuoteVersionSent(
  db: Database,
  params: {
    teamId: string;
    versionId: string;
    sentTo?: string | null;
    sentAt?: string;
    /**
     * `priceVersion` of this version, frozen: a sent quote is rendered from
     * it. Left out, it is worked out here, from the version as it is locked
     * and the rates that apply to it now.
     */
    pricing?: PricingResult | null;
    /** Keeps the PDF as it went out. Left out, nothing is stored. */
    storePdf?: StoreQuotePdf;
  },
) {
  const quoteId = await db.transaction(async (tx) => {
    const row = await lockVersion(tx, params.teamId, params.versionId);
    if (!row) return null;
    if (row.version.status !== "draft") {
      throw new QuoteInputError("Only a draft can be sent");
    }

    const pricing =
      params.pricing !== undefined
        ? params.pricing
        : priceVersion(
            row.version.content as QuoteContent,
            (await ratesForTeam(tx, params.teamId))(row.quote.customerId),
          );

    await tx
      .update(quoteVersions)
      .set({ status: "superseded", updatedAt: sql`now()` })
      .where(
        and(
          eq(quoteVersions.quoteId, row.quote.id),
          eq(quoteVersions.status, "sent"),
          ne(quoteVersions.id, row.version.id),
        ),
      );

    // A new version sent is a new offer: an earlier no is not its answer.
    if (row.quote.outcome === "lost" || row.quote.outcome === "no_decision") {
      await tx
        .update(quotes)
        .set({
          outcome: "open",
          outcomeReason: null,
          outcomeAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(quotes.id, row.quote.id));
    }

    await tx
      .update(quoteVersions)
      .set({
        status: "sent",
        sentAt: params.sentAt ?? sql`now()`,
        sentTo: params.sentTo ?? null,
        pricing,
        updatedAt: sql`now()`,
      })
      .where(eq(quoteVersions.id, row.version.id));

    // Read back through the same transaction, so the PDF is rendered from
    // the pricing just frozen rather than from today's rates.
    await keepPdf(tx, params.teamId, row.version.id, params.storePdf);

    return row.quote.id;
  });

  return quoteId ? getQuote(db, { id: quoteId, teamId: params.teamId }) : null;
}

/**
 * Renders a version as it now stands and records where the file was kept.
 * Called inside the transaction that froze the version, so what is rendered
 * is what was frozen, and a failure takes the whole thing back.
 */
async function keepPdf(
  tx: DatabaseOrTransaction,
  teamId: string,
  versionId: string,
  storePdf: StoreQuotePdf | undefined,
) {
  if (!storePdf) return;

  const input = await getQuotePdfInput(tx, { teamId, versionId });
  if (!input) {
    throw new Error(`Quote version ${versionId} vanished while being stored`);
  }

  await tx
    .update(quoteVersions)
    .set({ pdfPath: await storePdf(input), updatedAt: sql`now()` })
    .where(eq(quoteVersions.id, versionId));
}

/**
 * Records that a client accepted the version they hold (FF-1615): which
 * scenario, which of its optional items, who said so and when, the PO
 * number, and the document that says it. The version becomes `accepted` and
 * the quote is won.
 *
 * Recording it again on the same version replaces what was recorded — a
 * mistyped PO or the wrong scenario is otherwise stuck, because a won quote
 * keeps its outcome. Null when the version is not the team's.
 */
export async function acceptQuoteVersion(
  db: Database,
  params: {
    teamId: string;
    versionId: string;
    scenarioId: string;
    optionalLineIds?: string[];
    /** When the client accepted, not when this was typed in. */
    acceptedAt?: string;
    acceptedByName?: string | null;
    poNumber?: string | null;
    /** Path tokens of the order form in the `vault` bucket. */
    acceptanceFilePath?: string[] | null;
    today?: string;
    /** For a version sent before its PDF was kept; see `StoreQuotePdf`. */
    storePdf?: StoreQuotePdf;
  },
) {
  const today = params.today ?? todayUtc();
  const optionalLineIds = params.optionalLineIds ?? [];

  const quoteId = await db.transaction(async (tx) => {
    const row = await lockVersion(tx, params.teamId, params.versionId);
    if (!row) return null;
    const { version, quote } = row;

    // Sending supersedes the version before it, so the one the client holds
    // is the sent one — a revision drafted beside it is not what was
    // answered. An accepted one is here again to correct what was recorded.
    if (version.status !== "sent" && version.status !== "accepted") {
      throw new QuoteInputError(
        "Only the version the client holds can be accepted",
      );
    }
    if (isExpired(version, today)) {
      throw new QuoteInputError(
        "This version has expired; revise it and send it again",
      );
    }

    const problem = acceptanceProblem(version.content as QuoteContent, {
      scenarioId: params.scenarioId,
      optionalLineIds,
    });
    if (problem) throw new QuoteInputError(problem);

    const filePath = params.acceptanceFilePath?.length
      ? params.acceptanceFilePath
      : null;
    if (filePath && (filePath.length < 2 || filePath[0] !== params.teamId)) {
      throw new QuoteInputError(
        "The accepted document is stored outside this team",
      );
    }

    await tx
      .update(quoteVersions)
      .set({
        status: "accepted",
        acceptedScenarioId: params.scenarioId,
        acceptedOptionalLineIds: optionalLineIds,
        acceptedAt: params.acceptedAt ?? sql`now()`,
        acceptedByName: params.acceptedByName?.trim() || null,
        poNumber: params.poNumber?.trim() || null,
        acceptanceFilePath: filePath,
        updatedAt: sql`now()`,
      })
      .where(eq(quoteVersions.id, version.id));

    // Since FF-1615 the PDF is kept when a version is sent. One sent before
    // that has none, so it is rendered here instead — from the pricing
    // frozen at the time, which is what the client was quoted.
    if (!version.pdfPath?.length) {
      await keepPdf(tx, params.teamId, version.id, params.storePdf);
    }

    await tx
      .update(quotes)
      .set({
        outcome: "won",
        outcomeReason: null,
        outcomeAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(quotes.id, quote.id));

    return quote.id;
  });

  return quoteId
    ? getQuote(db, { id: quoteId, teamId: params.teamId, today })
    : null;
}

/**
 * A version's name and the PDF kept for it, when one was (FF-1615). The
 * download serves that file rather than drawing the quote again, which is
 * the whole point of keeping it. Null when the version is not the team's.
 */
export async function getQuoteVersionFile(
  db: DatabaseOrTransaction,
  params: { teamId: string; versionId: string },
) {
  const [row] = await db
    .select({
      pdfPath: quoteVersions.pdfPath,
      version: quoteVersions.version,
      quoteNumber: quotes.quoteNumber,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(
      and(
        eq(quoteVersions.id, params.versionId),
        eq(quoteVersions.teamId, params.teamId),
      ),
    );
  if (!row) return null;

  return { ...row, pdfPath: row.pdfPath?.length ? row.pdfPath : null };
}

/** A version's pricing: as frozen when it was sent, else worked out now. */
function pricingOf(
  version: { content: unknown; pricing: unknown },
  rates: ProductRates,
): PricingResult {
  return (
    (version.pricing as PricingResult | null) ??
    priceVersion(version.content as QuoteContent, rates)
  );
}

/** The team's product names by id, inactive ones included. */
async function productNamesFor(db: DatabaseOrTransaction, teamId: string) {
  const products = await db
    .select({ id: invoiceProducts.id, name: invoiceProducts.name })
    .from(invoiceProducts)
    .where(eq(invoiceProducts.teamId, teamId));
  return Object.fromEntries(products.map((p) => [p.id, p.name]));
}

/**
 * A quote with every version priced (FF-1618): a sent version from the
 * pricing frozen when it was sent, a draft at today's rates. With the
 * customer's name and the names of the team's products, which lines name.
 * Null when the quote is not the team's.
 */
export async function getPricedQuote(
  db: DatabaseOrTransaction,
  params: { id: string; teamId: string; today?: string },
) {
  const quote = await getQuote(db, params);
  if (!quote) return null;

  const ratesFor = await ratesForTeam(db, params.teamId);
  const [customer] = quote.customerId
    ? await db
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, quote.customerId))
    : [];

  return {
    ...quote,
    customerName: customer?.name ?? null,
    productNames: await productNamesFor(db, params.teamId),
    versions: quote.versions.map((version) => ({
      ...version,
      content: version.content as QuoteContent,
      pricing: pricingOf(version, ratesFor(quote.customerId)),
    })),
  };
}

/**
 * What the PDF of a version is made from (FF-1613): the version as it stands,
 * priced from the pricing frozen when it was sent, or at today's rates while
 * a draft (and for a version sent before pricing was frozen). Around it: the
 * product names, the countries that decide the VAT note, the team's labels,
 * and the logo and payment details of the default invoice template. Null
 * when the version is not the team's.
 */
export async function getQuotePdfInput(
  db: DatabaseOrTransaction,
  params: { teamId: string; versionId: string },
): Promise<QuotePdfInput | null> {
  const [row] = await db
    .select({ version: quoteVersions, quote: quotes })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(
      and(
        eq(quoteVersions.id, params.versionId),
        eq(quoteVersions.teamId, params.teamId),
      ),
    );
  if (!row) return null;
  const { quote, version } = row;
  const content = version.content as QuoteContent;

  const pricing = pricingOf(
    version,
    (await ratesForTeam(db, params.teamId))(quote.customerId),
  );

  const [customer] = quote.customerId
    ? await db
        .select({ countryCode: customers.countryCode })
        .from(customers)
        .where(eq(customers.id, quote.customerId))
    : [];
  const [team] = await db
    .select({ countryCode: teams.countryCode })
    .from(teams)
    .where(eq(teams.id, params.teamId));
  const [template] = await db
    .select({
      logoUrl: invoiceTemplates.logoUrl,
      paymentDetails: invoiceTemplates.paymentDetails,
    })
    .from(invoiceTemplates)
    .where(eq(invoiceTemplates.teamId, params.teamId))
    .orderBy(desc(invoiceTemplates.isDefault), invoiceTemplates.createdAt)
    .limit(1);
  const settings = await getQuoteSettings(db, params.teamId);

  return {
    quoteNumber: quote.quoteNumber,
    title: quote.title,
    kind: quote.kind,
    language: quote.language as PdfLanguage,
    currency: quote.currency,
    version: version.version,
    mode: version.mode,
    issueDate: version.issueDate,
    validUntil: version.validUntil,
    fromDetails: version.fromDetails,
    customerDetails: version.customerDetails,
    content,
    pricing,
    productNames: await productNamesFor(db, params.teamId),
    customerCountryCode: customer?.countryCode ?? null,
    teamCountryCode: team?.countryCode ?? null,
    labels: settings.labels,
    logoUrl: template?.logoUrl ?? null,
    paymentDetails: template?.paymentDetails ?? null,
  };
}

/**
 * Every product's price as its hourly rate, inactive ones included so older
 * lines still price, and every customer's own rate, in two reads. A product
 * without a price has no rate. A quote's own overrides are in its content.
 */
async function ratesForTeam(db: DatabaseOrTransaction, teamId: string) {
  const products = await db
    .select({ id: invoiceProducts.id, price: invoiceProducts.price })
    .from(invoiceProducts)
    .where(eq(invoiceProducts.teamId, teamId));
  const own = await db
    .select({
      customerId: customerProductRates.customerId,
      productId: customerProductRates.productId,
      hourlyRate: customerProductRates.hourlyRate,
    })
    .from(customerProductRates)
    .where(eq(customerProductRates.teamId, teamId));

  const defaultRates = Object.fromEntries(
    products.flatMap((p) => (p.price === null ? [] : [[p.id, p.price]])),
  );
  const byCustomer: Record<string, Record<string, number>> = {};
  for (const rate of own) {
    byCustomer[rate.customerId] ??= {};
    byCustomer[rate.customerId]![rate.productId] = rate.hourlyRate;
  }

  /** What `priceVersion` takes for a quote to this customer. */
  return (customerId: string | null): ProductRates => ({
    defaults: defaultRates,
    customer: (customerId && byCustomer[customerId]) || {},
  });
}

/**
 * The follow-up filters of the quotes list (FF-1614). Follow-up is about the
 * version the client holds — the one sent, which a revision in progress does
 * not take back — and about the answer recorded on the quote:
 * - draft: the latest version is a draft;
 * - awaiting: the version held is still valid, and no answer is recorded;
 * - expiring: awaiting, and valid until at most 7 days from today;
 * - expired: the version held is past its validity (`isExpired`), and no
 *   answer is recorded;
 * - won, lost: the outcome.
 */
export type QuoteListStatus =
  | "draft"
  | "awaiting"
  | "expiring"
  | "expired"
  | "won"
  | "lost";

const EXPIRING_DAYS = 7;

/**
 * Every quote of the team with its latest version, newest quote first, and
 * the one amount the list shows (`quoteHeadline`): from the frozen pricing
 * once sent, worked out with today's rates while a draft.
 */
export async function listQuotes(
  db: DatabaseOrTransaction,
  params: { teamId: string; status?: QuoteListStatus; today?: string },
) {
  const today = params.today ?? todayUtc();
  const latest = sql`(
    SELECT max(v.version) FROM quote_versions v WHERE v.quote_id = ${quotes.id}
  )`;
  // Sending one version supersedes the one before, so a quote holds at most
  // one — and once it is answered it is `accepted`, still the one held.
  const held = alias(quoteVersions, "held");
  const open = eq(quotes.outcome, "open");

  const filter = {
    draft: eq(quoteVersions.status, "draft"),
    awaiting: and(open, gte(held.validUntil, today)),
    expiring: and(
      open,
      gte(held.validUntil, today),
      lte(held.validUntil, addDays(today, EXPIRING_DAYS)),
    ),
    expired: and(open, lt(held.validUntil, today)),
    won: eq(quotes.outcome, "won"),
    lost: eq(quotes.outcome, "lost"),
  };

  const rows = await db
    .select({
      quote: quotes,
      customerName: customers.name,
      version: quoteVersions,
      held: {
        id: held.id,
        version: held.version,
        status: held.status,
        sentAt: held.sentAt,
        sentTo: held.sentTo,
        validUntil: held.validUntil,
      },
    })
    .from(quotes)
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.quoteId, quotes.id),
        eq(quoteVersions.version, latest),
      ),
    )
    .leftJoin(
      held,
      and(
        eq(held.quoteId, quotes.id),
        inArray(held.status, ["sent", "accepted"]),
      ),
    )
    .leftJoin(customers, eq(customers.id, quotes.customerId))
    .where(
      and(
        eq(quotes.teamId, params.teamId),
        params.status ? filter[params.status] : undefined,
      ),
    )
    .orderBy(desc(quotes.createdAt), desc(quotes.quoteNumber));

  const ratesFor = await ratesForTeam(db, params.teamId);

  return rows.map(({ quote, customerName, version, held }) => {
    const content = version.content as QuoteContent;
    const pricing = pricingOf(version, ratesFor(quote.customerId));
    return {
      ...quote,
      customerName,
      version: { ...version, expired: isExpired(version, today) },
      /** The version the client holds, when one was sent; null before. */
      held: held?.id ? { ...held, expired: isExpired(held, today) } : null,
      headline: quoteHeadline(content, pricing),
    };
  });
}

/**
 * Records that a quote was lost or left without a decision, with the reason;
 * `open` takes that back. Won is recorded by accepting a version (FF-1615),
 * so a won quote is not changed here. Null when the quote is not the team's.
 */
export async function setQuoteOutcome(
  db: Database,
  params: {
    teamId: string;
    quoteId: string;
    outcome: "open" | "lost" | "no_decision";
    reason: string | null;
  },
) {
  return db.transaction(async (tx) => {
    const [quote] = await tx
      .select({ outcome: quotes.outcome })
      .from(quotes)
      .where(
        and(eq(quotes.id, params.quoteId), eq(quotes.teamId, params.teamId)),
      )
      .for("update");
    if (!quote) return null;
    if (quote.outcome === "won") {
      throw new QuoteInputError("A won quote keeps its outcome");
    }

    const open = params.outcome === "open";
    const [updated] = await tx
      .update(quotes)
      .set({
        outcome: params.outcome,
        outcomeReason: open ? null : params.reason?.trim() || null,
        outcomeAt: open ? null : sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(quotes.id, params.quoteId))
      .returning();
    return updated ?? null;
  });
}
