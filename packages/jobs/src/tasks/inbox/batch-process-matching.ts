import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type BatchProcessMatchingPayload,
  batchProcessMatchingSchema,
} from "@jobs/schemas/inbox";
import { classifyError } from "@jobs/utils/error-classification";
import { triggerMatchingNotification } from "@jobs/utils/inbox-matching-notifications";
import { calculateInboxSuggestions, hasSuggestion } from "@midday/db/queries";
import { schemaTask } from "@trigger.dev/sdk";

export class BatchProcessMatchingProcessor extends BaseProcessor<BatchProcessMatchingPayload> {
  protected getPayloadSchema() {
    return batchProcessMatchingSchema;
  }
  async process(job: JobContext<BatchProcessMatchingPayload>): Promise<{
    processed: number;
    autoMatched: number;
    suggestions: number;
    noMatches: number;
    errors: number;
  }> {
    const { teamId, inboxIds } = job.data;
    const db = getDb();

    this.logger.info("Starting batch inbox matching", {
      teamId,
      inboxCount: inboxIds.length,
    });

    let autoMatchCount = 0;
    let suggestionCount = 0;
    let noMatchCount = 0;
    let errorCount = 0;

    // Process in smaller batches for better performance and error isolation
    const BATCH_SIZE = 5;
    const totalBatches = Math.ceil(inboxIds.length / BATCH_SIZE);
    const _progressPerBatch = 100 / totalBatches;

    for (let i = 0; i < inboxIds.length; i += BATCH_SIZE) {
      const batch = inboxIds.slice(i, i + BATCH_SIZE);
      const batchIndex = Math.floor(i / BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (inboxId) => {
          try {
            const result = await calculateInboxSuggestions(db, {
              teamId,
              inboxId,
            });

            // Send notifications based on matching result
            if (hasSuggestion(result)) {
              await triggerMatchingNotification({
                db,
                teamId,
                inboxId,
                result,
              });
            }

            switch (result.action) {
              case "auto_matched":
                autoMatchCount++;
                // suggestion is guaranteed to exist when action is "auto_matched"
                this.logger.info("Auto-matched inbox item", {
                  teamId,
                  inboxId,
                  transactionId: result.suggestion!.transactionId,
                  confidence: result.suggestion!.confidenceScore,
                });
                break;

              case "suggestion_created":
                suggestionCount++;
                // suggestion is guaranteed to exist when action is "suggestion_created"
                this.logger.info("Created match suggestion", {
                  teamId,
                  inboxId,
                  transactionId: result.suggestion!.transactionId,
                  confidence: result.suggestion!.confidenceScore,
                });
                break;

              case "no_match_yet":
                noMatchCount++;
                break;
            }

            return result;
          } catch (error) {
            errorCount++;
            const classified = classifyError(error);

            this.logger.error("Failed to process inbox matching", {
              teamId,
              inboxId,
              error: error instanceof Error ? error.message : "Unknown error",
              errorCategory: classified.category,
              retryable: classified.retryable,
            });

            throw error;
          }
        }),
      );

      // Log batch completion
      const batchErrors = results.filter((r) => r.status === "rejected").length;
      this.logger.info("Completed batch processing", {
        teamId,
        batchIndex: batchIndex + 1,
        batchSize: batch.length,
        errors: batchErrors,
      });
    }

    this.logger.info("Completed batch inbox matching", {
      teamId,
      summary: {
        totalProcessed: inboxIds.length,
        autoMatches: autoMatchCount,
        suggestions: suggestionCount,
        noMatches: noMatchCount,
        errors: errorCount,
      },
    });

    return {
      processed: inboxIds.length,
      autoMatched: autoMatchCount,
      suggestions: suggestionCount,
      noMatches: noMatchCount,
      errors: errorCount,
    };
  }
}

const processor = new BatchProcessMatchingProcessor();

export const batchProcessMatching = schemaTask({
  id: "batch-process-matching",
  schema: batchProcessMatchingSchema,
  machine: "micro",
  maxDuration: 180,
  queue: { concurrencyLimit: 3 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "batch-process-matching", payload, ctx),
});
