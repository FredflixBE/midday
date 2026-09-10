import { and, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import type { Database } from "../client";
import { transactions } from "../schema";

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
 * A row qualifies if enrichment has never finished for it, or if the last
 * attempt finished by failing. The second half is what makes a failed batch
 * replayable: without it, marking a failed batch complete (which the UI needs)
 * would make it permanently ineligible and re-running the task would quietly
 * find nothing to do.
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
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        inArray(transactions.id, params.transactionIds),
        or(
          eq(transactions.enrichmentCompleted, false),
          isNotNull(transactions.enrichmentFailedAt),
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
