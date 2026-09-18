import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type EnrichTransactionsPayload,
  enrichTransactionsSchema,
} from "@jobs/schemas/transactions";
import {
  generateEnrichmentPrompt,
  groupForEnrichment,
  prepareTransactionData,
  prepareUpdateData,
  resolveKnownCategories,
  settleWithoutModel,
} from "@jobs/utils/enrichment-helpers";
import { enrichmentSchema } from "@jobs/utils/enrichment-schema";
import { processBatch } from "@jobs/utils/process-batch";
import { askSuppliersWith } from "@jobs/utils/supplier-question";
import {
  getTransactionsForEnrichment,
  markTransactionsAsEnriched,
  markTransactionsAsEnrichmentFailed,
  recogniseSuppliers,
  setTransactionCategories,
  type UpdateTransactionEnrichmentParams,
  updateTransactionEnrichments,
} from "@midday/db/queries";
import { schemaTask } from "@trigger.dev/sdk";
import { generateObject } from "ai";

const BATCH_SIZE = 50;

// gemini-2.5-flash-lite was retired: Google returns "no longer available to
// new users" and names this as its successor. It is also the right size for
// the job — gemini-3-flash-preview handles the same batch correctly but takes
// ~200s to 3.5-flash-lite's ~2s.
const MODEL = "gemini-3.5-flash-lite";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
});

/**
 * What a run did, counted honestly.
 *
 * `enrichment_completed` goes true in all three cases — it means the process
 * finished, and it is what stops the dashboard showing a row as analyzing —
 * so a single count over it would report a total failure as a clean run. That
 * is the bug this shape exists to prevent (FF-1471).
 */
type EnrichmentTotals = {
  /** The model returned a merchant name or category and it was written. */
  enriched: number;
  /** The model answered but had nothing to change for these rows. */
  unchanged: number;
  /** The model call failed. These were marked finished, not enriched. */
  failed: number;
};

type BatchFailure = {
  error: unknown;
  message: string;
  count: number;
};

/**
 * Enriches transactions with AI (merchant names, categories)
 * Uses Google Generative AI (Gemini) to extract merchant names and categorize transactions
 */
export class EnrichTransactionProcessor extends BaseProcessor<EnrichTransactionsPayload> {
  async process(job: JobContext<EnrichTransactionsPayload>): Promise<{
    enrichedCount: number;
    unchangedCount: number;
    failedCount: number;
    teamId: string;
  }> {
    const { transactionIds, teamId } = job.data;
    const db = getDb();

    this.logger.info("Starting enrich-transactions job", {
      jobId: job.id,
      teamId,
      transactionCount: transactionIds.length,
    });

    // Get transactions that need enrichment
    const eligible = await getTransactionsForEnrichment(db, {
      transactionIds,
      teamId,
    });

    if (eligible.length === 0) {
      this.logger.info("No transactions need enrichment", { teamId });
      return {
        enrichedCount: 0,
        unchangedCount: 0,
        failedCount: 0,
        teamId,
      };
    }

    this.logger.info("Starting transaction enrichment", {
      teamId,
      transactionCount: eligible.length,
    });

    // Who was paid, before what it was for (FF-1555). Stored rules answer
    // first; the model is asked only about payments none of them recognise,
    // and its answer is kept as a rule so the same supplier is never asked
    // about twice. A failure here leaves those payments with no supplier —
    // visibly, on the row — and the run still categorises; it is reported as
    // a failure at the end rather than swallowed.
    let recognitionFailure: unknown = null;

    try {
      const recognition = await recogniseSuppliers(db, {
        teamId,
        transactions: eligible,
        ask: askSuppliersWith(google(MODEL)),
      });

      this.logger.info("Suppliers recognised", {
        teamId,
        linked: recognition.suppliers.size,
        of: eligible.length,
        counterpartiesAsked: recognition.asked,
        suppliersCreated: recognition.created,
        guessedWithoutRule: recognition.guessed,
        notAskedAgain: recognition.remembered,
      });
    } catch (error) {
      recognitionFailure = error;
      this.logger.error("Supplier recognition failed", {
        teamId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // Re-read, so every row carries the supplier recognition just wrote —
    // including the ones written before a failure.
    const recognised = await getTransactionsForEnrichment(db, {
      transactionIds: eligible.map((transaction) => transaction.id),
      teamId,
    });

    // What nothing needs to ask a model about: the bank's own ISO 20022 code,
    // and the category this team has already given that counterparty. Resolved
    // once per run, before any model call, and it wins over what comes back.
    // This is what stops one payroll agency being split across two categories.
    const known = await resolveKnownCategories(db, {
      teamId,
      batch: recognised,
    });

    const totals: EnrichmentTotals = { enriched: 0, unchanged: 0, failed: 0 };
    const failures: BatchFailure[] = [];

    // A payment from a supplier already known, whose category is decided or
    // remembered, is finished here with no model call. This is what keeps the
    // model's cost proportional to new suppliers rather than to payments.
    const settled = settleWithoutModel(recognised, known);

    if (settled.updates.length > 0) {
      await updateTransactionEnrichments(db, settled.updates);
      totals.enriched += settled.updates.length;
    }
    if (settled.unchanged.length > 0) {
      await markTransactionsAsEnriched(db, settled.unchanged);
      totals.unchanged += settled.unchanged.length;
    }

    const transactionsToEnrich = settled.toAsk;

    this.logger.info("Categories that need no model", {
      teamId,
      known: known.size,
      settledWithoutModel: settled.updates.length + settled.unchanged.length,
      toAsk: transactionsToEnrich.length,
      of: recognised.length,
    });

    // Process in batches of 50
    await processBatch(
      transactionsToEnrich,
      BATCH_SIZE,
      async (batch): Promise<string[]> => {
        // One question per counterparty, not one per payment. The same supplier
        // asked twice can be answered twice differently, which is exactly what
        // happened on the live books (FF-1554).
        const groups = groupForEnrichment(batch);
        const asked = groups.map((group) => group.asked);

        // Prepare transactions for LLM
        const transactionData = prepareTransactionData(asked);
        const prompt = generateEnrichmentPrompt(transactionData, asked);

        const batchIds = batch.filter((tx) => tx?.id).map((tx) => tx.id);

        // Rows this batch has already written a successful outcome for. A
        // write can fail partway through, and those rows must not then be
        // recorded as failures.
        const settled = new Set<string>();

        try {
          const { object } = await generateObject({
            model: google(MODEL),
            prompt,
            output: "array",
            schema: enrichmentSchema,
            temperature: 0.1, // Low temperature for consistency
          });

          // Prepare updates for batch processing
          const updates: UpdateTransactionEnrichmentParams[] = [];
          const noUpdateNeeded: string[] = [];
          let categoriesUpdated = 0;
          let skippedResults = 0;

          // With output: "array", object is the array directly
          const results = object;
          const resultsToProcess = Math.min(results.length, groups.length);

          for (let i = 0; i < resultsToProcess; i++) {
            const result = results[i];
            const group = groups[i];

            if (!result || !group) {
              skippedResults++;
              // Still mark the transactions as processed even if the LLM result
              // is invalid: the call succeeded, it just said nothing usable.
              if (group) {
                noUpdateNeeded.push(...group.transactions.map((tx) => tx.id));
              }
              continue;
            }

            // One answer, applied to every payment from that counterparty. Each
            // keeps its own guards — a payment somebody already categorised is
            // not overwritten just because its neighbour was answered.
            for (const transaction of group.transactions) {
              const updateData = prepareUpdateData(
                transaction,
                result,
                known.get(transaction.id),
              );

              // Check if any updates are needed
              if (!updateData.merchantName && !updateData.categorySlug) {
                // No updates needed - mark as enriched separately
                noUpdateNeeded.push(transaction.id);
                continue;
              }

              // Track if category was updated
              if (updateData.categorySlug) {
                categoriesUpdated++;
              }

              updates.push({
                transactionId: transaction.id,
                data: updateData,
              });
            }
          }

          // Log if we have mismatched result counts
          if (results.length !== groups.length) {
            this.logger.warn(
              "LLM returned different number of results than expected",
              {
                expectedCount: groups.length,
                actualCount: results.length,
                teamId,
              },
            );
          }

          // Rows the model returned no result for at all. The call succeeded,
          // it just had no answer for them, so they finished unchanged rather
          // than failed.
          const answered = new Set([
            ...updates.map((update) => update.transactionId),
            ...noUpdateNeeded,
          ]);
          const unanswered = batchIds.filter((id) => !answered.has(id));
          noUpdateNeeded.push(...unanswered);

          // Execute all updates
          if (updates.length > 0) {
            await updateTransactionEnrichments(db, updates);
            for (const update of updates) {
              settled.add(update.transactionId);
            }
            totals.enriched += updates.length;
          }

          // Mark transactions that don't need updates as enriched
          if (noUpdateNeeded.length > 0) {
            await markTransactionsAsEnriched(db, noUpdateNeeded);
            for (const id of noUpdateNeeded) {
              settled.add(id);
            }
            totals.unchanged += noUpdateNeeded.length;
          }

          this.logger.info("Enriched transaction batch", {
            batchSize: batch.length,
            counterpartiesAsked: groups.length,
            updatesApplied: updates.length,
            noUpdateNeeded: noUpdateNeeded.length,
            noResultReturned: unanswered.length,
            merchantNamesUpdated: updates.filter(
              (update) => update.data.merchantName,
            ).length,
            categoriesUpdated,
            skippedResults,
            teamId,
          });

          // Return ALL transaction IDs from the batch (all should now be marked as enriched)
          // Defensive handling for potentially falsy transactions
          return batchIds;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";

          this.logger.error("Failed to enrich transaction batch", {
            error: message,
            batchSize: batch.length,
            teamId,
          });

          // Anything this batch already wrote succeeded; only the rest failed.
          const failedIds = batchIds.filter((id) => !settled.has(id));

          try {
            // What the bank said, and what this team already decided, needed no
            // model. Losing those because the model call failed would leave them
            // out of the database for as long as the model keeps failing.
            await setTransactionCategories(
              db,
              failedIds
                .map((id) => ({
                  transactionId: id,
                  categorySlug: known.get(id),
                }))
                .filter(
                  (
                    entry,
                  ): entry is { transactionId: string; categorySlug: string } =>
                    entry.categorySlug !== undefined,
                ),
            );

            // Mark the failed rows completed so the UI stops showing them as
            // analyzing — enrichment_completed means the process finished, not
            // that it worked — and stamp enrichment_failed_at so the failure is
            // visible and the rows stay eligible for a replay.
            await markTransactionsAsEnrichmentFailed(db, failedIds);
            totals.failed += failedIds.length;
            failures.push({ error, message, count: failedIds.length });

            this.logger.warn(
              "Marked failed batch transactions as completed to prevent infinite loading",
              {
                count: failedIds.length,
                reason: "enrichment_process_failed_but_completed",
                teamId,
              },
            );

            // Return the valid transaction IDs even though enrichment failed
            return batchIds;
          } catch (markError) {
            this.logger.error(
              "Failed to mark transactions as completed after enrichment error",
              {
                markError:
                  markError instanceof Error
                    ? markError.message
                    : "Unknown error",
                originalError: message,
                batchSize: batch.length,
                teamId,
              },
            );
            throw error; // Re-throw original error
          }
        }
      },
    );

    const firstFailure = failures[0];

    if (firstFailure) {
      this.logger.error("Transaction enrichment failed", {
        ...totals,
        failedBatches: failures.length,
        teamId,
      });

      // Fail the run. Returning here is what made a total outage look like a
      // clean run in the dashboard, in runs.list and in anything alerting on
      // either. The counts go in the message because a failed run stores no
      // output.
      throw new Error(
        `Enrichment failed for ${totals.failed} of ${recognised.length} transactions ` +
          `in ${failures.length} of ${Math.ceil(transactionsToEnrich.length / BATCH_SIZE)} batches ` +
          `(${totals.enriched} enriched, ${totals.unchanged} unchanged). ` +
          `They are marked finished so the UI does not hang, and stay eligible ` +
          `for a replay. First failure: ${firstFailure.message}`,
        { cause: firstFailure.error },
      );
    }

    if (recognitionFailure) {
      // Categorisation finished; only the supplier half did not. Failing the
      // run is what makes that visible where runs are watched. The payments
      // it missed show "no supplier", and `bun run --cwd packages/jobs
      // link-suppliers` recognises them later.
      throw new Error(
        `Supplier recognition failed for team ${teamId}; categorisation completed ` +
          `(${totals.enriched} enriched, ${totals.unchanged} unchanged). ` +
          `First failure: ${recognitionFailure instanceof Error ? recognitionFailure.message : "Unknown error"}`,
        { cause: recognitionFailure },
      );
    }

    this.logger.info("Transaction enrichment completed", {
      ...totals,
      teamId,
    });

    return {
      enrichedCount: totals.enriched,
      unchangedCount: totals.unchanged,
      failedCount: totals.failed,
      teamId,
    };
  }
}

const processor = new EnrichTransactionProcessor();

export const enrichTransactions = schemaTask({
  id: "enrich-transactions",
  schema: enrichTransactionsSchema,
  machine: "micro",
  maxDuration: 300,
  // Kept low to bound Gemini spend rather than for throughput.
  queue: { concurrencyLimit: 2 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "enrich-transactions", payload, ctx),
});
