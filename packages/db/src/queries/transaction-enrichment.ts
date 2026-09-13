import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "../client";
import { transactions } from "../schema";

/**
 * Where a run parks a payment it could not classify. Not an answer: a row here
 * has been asked about and nobody could say, so it is still work.
 */
export const UNCATEGORIZED = "uncategorized";

export type GetTransactionsForEnrichmentParams = {
  transactionIds: string[];
  teamId: string;
};

export type TransactionForEnrichment = {
  id: string;
  name: string;
  counterpartyName: string | null;
  merchantName: string | null;
  description: string | null;
  amount: number;
  currency: string;
  categorySlug: string | null;
  /** What the bank itself called this payment, where it said (FF-1557). */
  bankTransactionCode: string | null;
  bankTransactionSubCode: string | null;
};

export type EnrichmentUpdateData = {
  merchantName?: string;
  categorySlug?: string;
};

export type UpdateTransactionEnrichmentParams = {
  transactionId: string;
  data: EnrichmentUpdateData;
};

/**
 * Get the transactions a run should enrich.
 *
 * A row qualifies on any of three counts: enrichment has never finished for it,
 * the last attempt finished by failing, or it finished and gave up — landing in
 * `uncategorized`.
 *
 * The second is what makes a failed batch replayable: without it, marking a
 * failed batch complete (which the UI needs) would make it permanently
 * ineligible and re-running the task would quietly find nothing to do.
 *
 * The third is what let EUR 52,288 of bank payments sit unclassified with no way
 * back. A run that could not name a category wrote `uncategorized` and marked
 * the row finished, and both halves of that then excluded it forever — so fixing
 * the categoriser changed nothing for the rows it had already given up on
 * (FF-1554). `uncategorized` is a parking space, and a row in it is still work.
 */
export async function getTransactionsForEnrichment(
  db: Database,
  params: GetTransactionsForEnrichmentParams,
): Promise<TransactionForEnrichment[]> {
  if (params.transactionIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: transactions.id,
      name: transactions.name,
      counterpartyName: transactions.counterpartyName,
      merchantName: transactions.merchantName,
      description: transactions.description,
      amount: transactions.amount,
      currency: transactions.currency,
      categorySlug: transactions.categorySlug,
      bankTransactionCode: transactions.bankTransactionCode,
      bankTransactionSubCode: transactions.bankTransactionSubCode,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        inArray(transactions.id, params.transactionIds),
        or(
          eq(transactions.enrichmentCompleted, false),
          isNotNull(transactions.enrichmentFailedAt),
          eq(transactions.categorySlug, UNCATEGORIZED),
        ),
      ),
    );
}

export type GetCategoriesByCounterpartyParams = {
  teamId: string;
  /** Counterparty names as they appear on the transaction, any casing. */
  names: string[];
};

/**
 * The category this team has already given each of these counterparties.
 *
 * This is the memory that makes the answer stable. The categoriser is a model,
 * and a model asked the same question twice can answer differently — which is
 * how one payroll agency ended up split across two categories. Once a payment
 * from a counterparty is classified, every later payment from the same
 * counterparty takes that category without asking.
 *
 * It also makes a correction stick: recategorise one payment by hand and the
 * next one from that supplier follows, which is the behaviour anyone keeping
 * books expects and the reason this reads transactions rather than a cache.
 *
 * Deliberately **not** a supplier record. It is an exact match on the trimmed,
 * lower-cased name, with no identity, no merging of near-duplicates and nothing
 * stored. Real supplier identity is FF-1555, and this must not grow into it.
 *
 * **It answers only where this team has been consistent.** A counterparty that
 * has been given two different categories is a disagreement, and propagating the
 * majority would entrench whichever answer happened to win — the live books have
 * Xerius under `contractors` twice and `employer-taxes` once, and the one that
 * loses that vote is the right one. So a split counterparty gets no answer here
 * and goes to the model, and the moment somebody tidies it up to one category it
 * becomes deterministic for good.
 *
 * Expenses only. Money coming in is categorised by a different logic, and a
 * counterparty that both pays and is paid — a tax office that also issues
 * refunds — would otherwise teach this an income category.
 */
export async function getCategoriesByCounterparty(
  db: Database,
  params: GetCategoriesByCounterpartyParams,
): Promise<Map<string, string>> {
  const wanted = [
    ...new Set(
      params.names
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    ),
  ];

  if (wanted.length === 0) {
    return new Map();
  }

  // The SQL twin of `counterpartyKey`. `nullif` on each side, not a plain
  // coalesce: a counterparty of `"  "` must fall through to the merchant name
  // here exactly as it does there, or the two disagree about who a payment was to.
  const name = sql<string>`coalesce(
    nullif(lower(trim(${transactions.counterpartyName})), ''),
    nullif(lower(trim(${transactions.merchantName})), '')
  )`;

  const rows = await db
    .select({
      name,
      categorySlug: transactions.categorySlug,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        isNotNull(transactions.categorySlug),
        ne(transactions.categorySlug, UNCATEGORIZED),
        lte(transactions.amount, 0),
        inArray(name, wanted),
      ),
    )
    .groupBy(name, transactions.categorySlug);

  // One row per (name, category). A name with more than one is a name this team
  // has not made up its mind about, and it is dropped rather than voted on.
  const byName = new Map<string, string | null>();

  for (const row of rows) {
    if (!row.categorySlug) continue;

    if (byName.has(row.name) && byName.get(row.name) !== row.categorySlug) {
      byName.set(row.name, null);
      continue;
    }

    byName.set(row.name, row.categorySlug);
  }

  const agreed = new Map<string, string>();

  for (const [name, categorySlug] of byName) {
    if (categorySlug) {
      agreed.set(name, categorySlug);
    }
  }

  return agreed;
}

export type SetTransactionCategoriesParams = {
  transactionId: string;
  categorySlug: string;
};

/**
 * Write a category that did not come from the model, and touch nothing else.
 *
 * Used when the model call fails. The bank's own ISO 20022 code and the category
 * this team already gave the counterparty needed no model, and dropping them
 * because a separate leg failed means a persistently broken model key keeps the
 * deterministic answers out of the database indefinitely.
 *
 * Deliberately leaves `enrichment_completed` and `enrichment_failed_at` alone:
 * the merchant name genuinely did not enrich, and those two are what keep the
 * row eligible for the replay that will get it (FF-1471).
 *
 * Refuses to overwrite a category somebody chose, in case one arrived between
 * the read and this write.
 */
export async function setTransactionCategories(
  db: Database,
  entries: SetTransactionCategoriesParams[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await Promise.all(
    entries.map((entry) =>
      db
        .update(transactions)
        .set({ categorySlug: entry.categorySlug })
        .where(
          and(
            eq(transactions.id, entry.transactionId),
            or(
              isNull(transactions.categorySlug),
              eq(transactions.categorySlug, UNCATEGORIZED),
            ),
          ),
        ),
    ),
  );
}

/**
 * Update multiple transactions with enrichment data using individual updates
 *
 * @param db - Database connection
 * @param updates - Array of updates to apply (max 1000 for safety)
 * @throws Error if batch size exceeds limit or if updates fail
 */
export async function updateTransactionEnrichments(
  db: Database,
  updates: UpdateTransactionEnrichmentParams[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  // Safety: Limit batch size to prevent query size issues
  if (updates.length > 1000) {
    throw new Error(
      `Batch size too large: ${updates.length}. Maximum allowed: 1000`,
    );
  }

  // Safety: Validate input data
  for (const update of updates) {
    if (!update.transactionId?.trim()) {
      throw new Error("Invalid transactionId: cannot be empty");
    }
    // At least one field must be provided for update
    if (!update.data.merchantName && !update.data.categorySlug) {
      throw new Error(
        "At least one of merchantName or categorySlug must be provided",
      );
    }
    // If merchantName is provided, it cannot be empty
    if (
      update.data.merchantName !== undefined &&
      !update.data.merchantName?.trim()
    ) {
      throw new Error("Invalid merchantName: cannot be empty when provided");
    }
  }

  try {
    // Deduplicate by transactionId — later entries override earlier ones so
    // the result matches sequential semantics if callers ever pass duplicates.
    const deduped = new Map<string, EnrichmentUpdateData>();
    for (const update of updates) {
      const existing = deduped.get(update.transactionId);
      deduped.set(
        update.transactionId,
        existing ? { ...existing, ...update.data } : { ...update.data },
      );
    }

    const uniqueUpdates = Array.from(deduped.entries());

    const CHUNK_SIZE = 50;
    for (let i = 0; i < uniqueUpdates.length; i += CHUNK_SIZE) {
      const chunk = uniqueUpdates.slice(i, i + CHUNK_SIZE);

      await Promise.all(
        chunk.map(([transactionId, data]) => {
          const updateData: {
            merchantName?: string;
            categorySlug?: string;
            enrichmentCompleted: boolean;
            enrichmentFailedAt: null;
          } = {
            enrichmentCompleted: true,
            // This row enriched, so any earlier failure no longer stands.
            enrichmentFailedAt: null,
          };

          if (data.merchantName) {
            updateData.merchantName = data.merchantName;
          }
          if (data.categorySlug) {
            updateData.categorySlug = data.categorySlug;
          }

          return db
            .update(transactions)
            .set(updateData)
            .where(eq(transactions.id, transactionId));
        }),
      );
    }
  } catch (error) {
    throw new Error(
      `Failed to update transaction enrichments: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Validate a set of transaction ids destined for a bulk `enrichment_completed`
 * write, then apply `values` to all of them.
 */
async function markTransactions(
  db: Database,
  transactionIds: string[],
  values: { enrichmentCompleted: true; enrichmentFailedAt: SQL | null },
  description: string,
): Promise<void> {
  if (transactionIds.length === 0) {
    return;
  }

  // Safety: Limit batch size to prevent query size issues
  if (transactionIds.length > 1000) {
    throw new Error(
      `Batch size too large: ${transactionIds.length}. Maximum allowed: 1000`,
    );
  }

  // Safety: Validate input data
  for (const id of transactionIds) {
    if (!id?.trim()) {
      throw new Error("Invalid transactionId: cannot be empty");
    }
  }

  try {
    await db
      .update(transactions)
      .set(values)
      .where(inArray(transactions.id, transactionIds));
  } catch (error) {
    throw new Error(
      `Failed to ${description}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Mark transactions as enrichment completed without updating any other fields.
 * Used for transactions the model processed successfully but that needed no
 * merchant/category change, so any earlier failure marker is cleared.
 *
 * @param db - Database connection
 * @param transactionIds - Array of transaction IDs to mark as enriched
 */
export async function markTransactionsAsEnriched(
  db: Database,
  transactionIds: string[],
): Promise<void> {
  await markTransactions(
    db,
    transactionIds,
    { enrichmentCompleted: true, enrichmentFailedAt: null },
    "mark transactions as enriched",
  );
}

/**
 * Mark transactions as enrichment completed *after the enrichment failed*.
 *
 * `enrichment_completed` still goes true so the UI stops showing them as
 * analyzing, but `enrichment_failed_at` records that nothing was actually
 * enriched — which is also what keeps them eligible for a replay.
 *
 * @param db - Database connection
 * @param transactionIds - Array of transaction IDs whose enrichment failed
 */
export async function markTransactionsAsEnrichmentFailed(
  db: Database,
  transactionIds: string[],
): Promise<void> {
  await markTransactions(
    db,
    transactionIds,
    { enrichmentCompleted: true, enrichmentFailedAt: sql`now()` },
    "mark transactions as enrichment failed",
  );
}
