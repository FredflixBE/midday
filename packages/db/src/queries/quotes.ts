import { businessIdentityDoc } from "@midday/invoice/business-identity";
import { transformCustomerToContent } from "@midday/invoice/utils";
import { createLoggerWithContext } from "@midday/logger";
import {
  type Acceptance,
  acceptanceProblem,
  type Block,
  blockSchema,
  formatQuoteVersion,
  imagePathsIn,
  initialQuoteContent,
  isExpired,
  nextQuoteNumber,
  type PricingResult,
  type ProductRates,
  parseQuoteContent,
  priceVersion,
  type QuoteContent,
  type QuoteKind,
  quoteBudget,
  quoteHeadline,
  quoteNumberSequence,
} from "@midday/quote";
import type {
  QuoteLanguage as PdfLanguage,
  QuotePdfInput,
} from "@midday/quote/pdf";
import { and, desc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  customerProductRates,
  customers,
  invoiceProducts,
  invoiceTemplates,
  quoteSettings,
  quotes,
  quoteTerms,
  quoteVersions,
  teams,
  trackerProjects,
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

const logger = createLoggerWithContext("quotes");

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

/**
 * Lets go of pictures a draft edit took out of a quote's text (FF-1626).
 * Storage does not belong here either, so the caller passes this in, and
 * this module decides when it runs: after the edit is committed, never
 * inside it, because an edit that was rolled back must leave every file
 * where it was.
 *
 * What it is handed is never anything but a picture. The candidates are the
 * paths this edit took *out of a version's text*, so the other three kinds
 * of file under `<team>/quotes/` — the PDF kept when a version was sent, the
 * order form attached at acceptance, the team's general terms — are not
 * reached by the ordinary path: none of them is ever written into a
 * version's content. They are also checked for by name before anything is
 * deleted, because a version's text is a Tiptap document nothing validates
 * the inside of, and a crafted save could name any path at all.
 */
export type DropQuoteImages = (paths: string[]) => Promise<void>;

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

/**
 * The sender, as the business's own identity has it (FF-1641) — falling back
 * to the free text of the default invoice template's From box for a team
 * that has not filled the identity in.
 *
 * This is read at sending, not at creation. A draft reads it live, which is
 * the same rule the general terms are on (FF-1616) and the stored PDF
 * (FF-1615): what the client holds must not change retroactively because the
 * business moved office, but a draft should show what it would go out with.
 * It used to be snapshotted when the quote was created, so a quote started
 * before the details were typed in kept an empty From for good — and
 * revising it copied that emptiness rather than putting it right.
 */
async function senderSnapshot(db: DatabaseOrTransaction, teamId: string) {
  const [team] = await db
    .select({
      legalName: teams.legalName,
      legalForm: teams.legalForm,
      addressLine1: teams.addressLine1,
      addressLine2: teams.addressLine2,
      zip: teams.zip,
      city: teams.city,
      countryCode: teams.countryCode,
      enterpriseNumber: teams.enterpriseNumber,
      rprCourt: teams.rprCourt,
      bankIban: teams.bankIban,
      bankBic: teams.bankBic,
    })
    .from(teams)
    .where(eq(teams.id, teamId));

  if (team) {
    const identity = businessIdentityDoc(team);
    if (identity) return identity;
  }

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
      // No sender is snapshotted on a draft (FF-1641): it is read live until
      // the version is sent, so filling the details in afterwards puts every
      // draft right rather than none of them.
      fromDetails: null,
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
 * Of the pictures an edit took out, the ones no version of any of the team's
 * quotes names any more — the only ones it is safe to let go of.
 *
 * A picture a sent or superseded version holds is kept even though that
 * version's PDF was stored whole (FF-1615) and no longer depends on the
 * file: the editor still draws a sent version's text from the path, so
 * deleting it would leave a hole on screen.
 *
 * The `like` is a narrowing filter, not the answer — the answer is
 * `imagePathsIn` on the rows it lets through, so a path that merely appears
 * somewhere in the text cannot keep a picture alive by accident.
 */
async function orphanedImages(
  tx: DatabaseOrTransaction,
  teamId: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];

  const rows = await tx
    .select({ content: quoteVersions.content })
    .from(quoteVersions)
    .where(
      and(
        eq(quoteVersions.teamId, teamId),
        or(
          ...paths.map(
            (path) => sql`${quoteVersions.content}::text like ${`%${path}%`}`,
          ),
        ),
      ),
    );

  const named = new Set(
    rows.flatMap((row) => imagePathsIn(row.content as QuoteContent)),
  );
  const kept = await keptFiles(tx, teamId, paths);

  return paths.filter((path) => !named.has(path) && !kept.has(path));
}

/** A path column of the `vault` bucket read as the path it stands for. */
const storedAt = (column: AnyPgColumn) =>
  sql<string>`array_to_string(${column}, '/')`;

/**
 * Which of these paths are one of the other three kinds of file kept under
 * `<team>/quotes/`: the PDF of a sent version, the order form attached at
 * acceptance, or a version of the team's general terms.
 *
 * In principle none of them can ever be a candidate — each is written to a
 * column of its own and never into a version's text. In practice a version's
 * text is a Tiptap document the content schema does not look inside, so a
 * crafted save could write a picture node pointing at the stored PDF, and a
 * second save could drop it again. This is what makes "only pictures are
 * ever deleted" true rather than merely intended.
 */
async function keptFiles(
  tx: DatabaseOrTransaction,
  teamId: string,
  paths: string[],
): Promise<Set<string>> {
  const versionFiles = await tx
    .select({
      pdf: storedAt(quoteVersions.pdfPath),
      acceptance: storedAt(quoteVersions.acceptanceFilePath),
    })
    .from(quoteVersions)
    .where(
      and(
        eq(quoteVersions.teamId, teamId),
        or(
          inArray(storedAt(quoteVersions.pdfPath), paths),
          inArray(storedAt(quoteVersions.acceptanceFilePath), paths),
        ),
      ),
    );

  const termsFiles = await tx
    .select({ terms: storedAt(quoteTerms.filePath) })
    .from(quoteTerms)
    .where(
      and(
        eq(quoteTerms.teamId, teamId),
        inArray(storedAt(quoteTerms.filePath), paths),
      ),
    );

  return new Set(
    [
      ...versionFiles.flatMap((row) => [row.pdf, row.acceptance]),
      ...termsFiles.map((row) => row.terms),
    ].filter((path): path is string => Boolean(path)),
  );
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
    /**
     * Lets go of the pictures this edit took out of the text and nothing
     * else names. Left out, nothing is deleted and the files simply stay.
     */
    dropImages?: DropQuoteImages;
  },
) {
  const edited = await db.transaction(async (tx) => {
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

    const dropped =
      content === undefined
        ? []
        : imagePathsIn(version.content as QuoteContent).filter(
            (path) => !imagePathsIn(content).includes(path),
          );

    return {
      quoteId: quote.id,
      // Looked for after the write, so the version being edited counts as
      // it now stands rather than as it was.
      orphans: await orphanedImages(tx, params.teamId, dropped),
    };
  });

  if (!edited) return null;

  // After the commit, and never at the cost of the edit: a file nobody can
  // see costs storage, where a failed edit costs the work that went into it.
  // Said out loud, because nothing else will ever notice it stayed.
  if (edited.orphans.length > 0 && params.dropImages) {
    await params.dropImages(edited.orphans).catch((error) => {
      logger.warn("Quote pictures stayed in the vault", {
        paths: edited.orphans,
        error,
      });
    });
  }

  return getQuote(db, { id: edited.quoteId, teamId: params.teamId });
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
      // Not copied from the version before it (FF-1641). A revision is a
      // draft, and a draft reads the sender live — copying is what kept a
      // quote's empty From empty however often it was revised.
      fromDetails: null,
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
 * The team's general terms versions (FF-1616, docs/quotes.md §3.4), newest
 * first. General terms only bind if the client could know them before the
 * contract was concluded (Civil Code art. 5.23), so each version is kept as
 * its own file and a sent quote records which one went with it.
 */
export async function listQuoteTerms(
  db: DatabaseOrTransaction,
  params: { teamId: string },
) {
  return db
    .select()
    .from(quoteTerms)
    .where(eq(quoteTerms.teamId, params.teamId))
    .orderBy(desc(quoteTerms.createdAt));
}

/** The newest version in a language, which is what a quote is sent with. */
async function latestQuoteTerms(
  tx: DatabaseOrTransaction,
  teamId: string,
  language: string,
) {
  const [row] = await tx
    .select({ id: quoteTerms.id })
    .from(quoteTerms)
    .where(
      and(eq(quoteTerms.teamId, teamId), eq(quoteTerms.language, language)),
    )
    .orderBy(desc(quoteTerms.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** A new version of the terms, the file already stored in the vault. */
export async function addQuoteTerms(
  db: Database,
  params: {
    teamId: string;
    label: string;
    language: QuoteLanguage;
    filePath: string[];
    fileName: string;
  },
) {
  const label = params.label.trim();
  if (!label) throw new QuoteInputError("A version needs a label");
  if (params.filePath[0] !== params.teamId || params.filePath.length < 2) {
    throw new QuoteInputError("The file is stored outside this team");
  }

  const [row] = await db
    .insert(quoteTerms)
    .values({ ...params, label })
    .onConflictDoNothing({
      target: [quoteTerms.teamId, quoteTerms.label, quoteTerms.language],
    })
    .returning();
  if (!row) {
    throw new QuoteInputError("That version already exists in this language");
  }
  return row;
}

/**
 * Removes a version of the terms — a wrong upload, before it was used. One a
 * sent quote names stays: which terms went with it is the record this table
 * exists for. Null when it is not the team's.
 */
export async function deleteQuoteTerms(
  db: Database,
  params: { teamId: string; id: string },
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: quoteTerms.id })
      .from(quoteTerms)
      .where(
        and(eq(quoteTerms.id, params.id), eq(quoteTerms.teamId, params.teamId)),
      );
    if (!row) return null;

    const [used] = await tx
      .select({ id: quoteVersions.id })
      .from(quoteVersions)
      .where(eq(quoteVersions.termsVersionId, params.id))
      .limit(1);
    if (used) {
      throw new QuoteInputError("A quote was sent with these terms");
    }

    await tx.delete(quoteTerms).where(eq(quoteTerms.id, params.id));
    return row;
  });
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
    // A won quote has been answered. Sending a draft left open beside the
    // accepted version would leave the quote holding two: the accepted one,
    // which is not superseded because it is the answer, and a new sent one.
    if (row.quote.outcome === "won") {
      throw new QuoteInputError("This quote has already been accepted");
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
        // The sender is frozen here, not when the quote was started
        // (FF-1641): what the client holds must not change because the
        // business later moved office, but a draft must still show the
        // details as they stand today.
        fromDetails: await senderSnapshot(tx, params.teamId),
        // The terms in force for this language, recorded before the PDF is
        // drawn so the file names them (FF-1616). None on file, none named.
        termsVersionId: await latestQuoteTerms(
          tx,
          params.teamId,
          row.quote.language,
        ),
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
 * The tracker project an accepted quote becomes (FF-1617, docs/quotes.md
 * §8.7), so quoted and tracked hours can be compared from day one. One
 * project per quote: accepting again — a corrected scenario, an optional
 * item that was in fact taken — moves the same project rather than adding a
 * second. Gives back the project's id, for the quote to hold.
 *
 * A project carries one rate and an estimate in whole hours, which is what
 * `quoteBudget` flattens the accepted scenario to. A version sent before
 * pricing was frozen has none, so its budget is worked out at today's rates
 * — the same reading the PDF and the editor give it.
 */
async function upsertTrackerProjectFor(
  tx: DatabaseOrTransaction,
  params: {
    teamId: string;
    quote: typeof quotes.$inferSelect;
    version: typeof quoteVersions.$inferSelect;
    acceptance: Acceptance;
  },
) {
  const { quote, version } = params;
  const ratesFor = await ratesForTeam(tx, params.teamId);
  const budget = quoteBudget(
    version.content as QuoteContent,
    pricingOf(version, ratesFor(quote.customerId)),
    params.acceptance,
  );

  const budgetValues = {
    rate: budget?.rate ?? null,
    estimate: budget?.estimate ?? null,
  };

  // Only the budget is written again. What the project was called, who it
  // is for and how it is run belong to the tracker once it exists there,
  // and a correction to the answer is not a reason to undo a rename.
  if (quote.trackerProjectId) {
    const [moved] = await tx
      .update(trackerProjects)
      .set(budgetValues)
      .where(
        and(
          eq(trackerProjects.id, quote.trackerProjectId),
          eq(trackerProjects.teamId, params.teamId),
        ),
      )
      .returning({ id: trackerProjects.id });
    if (moved) return moved.id;
  }

  const [project] = await tx
    .insert(trackerProjects)
    .values({
      ...budgetValues,
      teamId: params.teamId,
      name: quote.title,
      // The one way back to the quote from the tracker side.
      description: formatQuoteVersion(quote.quoteNumber, version.version),
      customerId: quote.customerId,
      currency: quote.currency,
      billable: true,
    })
    .returning({ id: trackerProjects.id });
  return project!.id;
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
        trackerProjectId: await upsertTrackerProjectFor(tx, {
          teamId: params.teamId,
          quote,
          version,
          acceptance: { scenarioId: params.scenarioId, optionalLineIds },
        }),
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
 * Takes back a recorded acceptance (FF-1636). The version goes back to
 * `sent` and the quote to `open`, so a quote won by mistake has a route out
 * — until now, a won quote hid both Revise and the Outcome menu and only
 * what had been *recorded* could be corrected, never the win itself.
 *
 * Three things are deliberately left standing:
 *
 * - **The tracker project.** Someone may already have booked time against
 *   it, and deleting that would be worse than the problem. `trackerProjectId`
 *   stays on the quote too, so accepting again moves that project rather
 *   than adding a second one.
 * - **The stored PDF.** It is the file the client holds, kept at sending
 *   (FF-1615); the answer being withdrawn does not change what went out.
 * - **The order form in the vault.** Only the version's reference to it is
 *   cleared, because the record must read as not accepted. The file itself
 *   is someone's upload, and this is not the place to delete it.
 *
 * Null when the version is not the team's.
 */
export async function undoQuoteAcceptance(
  db: Database,
  params: { teamId: string; versionId: string; today?: string },
) {
  const today = params.today ?? todayUtc();

  const quoteId = await db.transaction(async (tx) => {
    const row = await lockVersion(tx, params.teamId, params.versionId);
    if (!row) return null;
    const { version, quote } = row;

    if (version.status !== "accepted") {
      throw new QuoteInputError("Only an accepted version can be taken back");
    }

    await tx
      .update(quoteVersions)
      .set({
        status: "sent",
        acceptedScenarioId: null,
        acceptedOptionalLineIds: null,
        acceptedAt: null,
        acceptedByName: null,
        poNumber: null,
        acceptanceFilePath: null,
        updatedAt: sql`now()`,
      })
      .where(eq(quoteVersions.id, version.id));

    await tx
      .update(quotes)
      .set({
        outcome: "open",
        outcomeReason: null,
        outcomeAt: null,
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

  // The terms this version went out with (FF-1616). A draft has none
  // recorded yet, so it is drawn with the ones it would be sent with —
  // otherwise the PDF a person downloads and emails would say nothing about
  // terms while the copy kept at send says they apply.
  const termsId =
    version.termsVersionId ??
    (version.status === "draft"
      ? await latestQuoteTerms(db, params.teamId, quote.language)
      : null);
  const [terms] = termsId
    ? await db
        .select({ label: quoteTerms.label })
        .from(quoteTerms)
        .where(eq(quoteTerms.id, termsId))
    : [];

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
    // A draft is drawn with the sender it would be sent with; only a version
    // the client holds keeps the one frozen onto it (FF-1641). The draft's
    // own column is ignored rather than preferred, because a quote started
    // before this changed still carries the copy taken at creation — which
    // is the stale block this ticket is about, and no amount of filling the
    // details in would displace it if that copy won.
    fromDetails:
      version.status === "draft"
        ? await senderSnapshot(db, params.teamId)
        : version.fromDetails,
    customerDetails: version.customerDetails,
    content,
    pricing,
    productNames: await productNamesFor(db, params.teamId),
    customerCountryCode: customer?.countryCode ?? null,
    teamCountryCode: team?.countryCode ?? null,
    labels: settings.labels,
    logoUrl: template?.logoUrl ?? null,
    paymentDetails: template?.paymentDetails ?? null,
    termsLabel: terms?.label ?? null,
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
  // The version the client holds: the one that was sent, or the one they
  // accepted. Read as the newest of those rather than by status alone, so a
  // quote can never match twice and appear twice in the list.
  const held = alias(quoteVersions, "held");
  const heldVersion = sql`(
    SELECT max(v.version) FROM quote_versions v
    WHERE v.quote_id = ${quotes.id} AND v.status IN ('sent', 'accepted')
  )`;
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
      and(eq(held.quoteId, quotes.id), eq(held.version, heldVersion)),
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
