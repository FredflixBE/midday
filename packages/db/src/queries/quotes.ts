import { transformCustomerToContent } from "@midday/invoice/utils";
import {
  type Block,
  blockSchema,
  initialQuoteContent,
  isExpired,
  nextQuoteNumber,
  parseQuoteContent,
  type QuoteContent,
  type QuoteKind,
  quoteNumberSequence,
} from "@midday/quote";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  customers,
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
 */
export async function markQuoteVersionSent(
  db: Database,
  params: {
    teamId: string;
    versionId: string;
    sentTo?: string | null;
    sentAt?: string;
    pricing: unknown;
  },
) {
  const quoteId = await db.transaction(async (tx) => {
    const row = await lockVersion(tx, params.teamId, params.versionId);
    if (!row) return null;
    if (row.version.status !== "draft") {
      throw new QuoteInputError("Only a draft can be sent");
    }

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

    await tx
      .update(quoteVersions)
      .set({
        status: "sent",
        sentAt: params.sentAt ?? sql`now()`,
        sentTo: params.sentTo ?? null,
        pricing: params.pricing ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(quoteVersions.id, row.version.id));

    return row.quote.id;
  });

  return quoteId ? getQuote(db, { id: quoteId, teamId: params.teamId }) : null;
}
