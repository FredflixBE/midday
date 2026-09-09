import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type ImportTransactionsPayload,
  importTransactionsSchema,
} from "@jobs/schemas/transactions";
import { processBatch } from "@jobs/utils/process-batch";
import { TIMEOUTS, withTimeout } from "@jobs/utils/timeout";
import { upsertTransactions } from "@midday/db/queries";
import { mapTransactions } from "@midday/import/mappings";
import { transform } from "@midday/import/transform";
import { validateTransactions } from "@midday/import/validate";
import { createClient } from "@midday/supabase/job";
import { schemaTask } from "@trigger.dev/sdk";
import Papa from "papaparse";
import { matchTransactionsBidirectional } from "../inbox/match-transactions-bidirectional";
import { enrichTransactions } from "./enrich-transaction";

const BATCH_SIZE = 500;

/**
 * Imports transactions from CSV files
 * Parses CSV, maps columns, validates, and upserts transactions
 * Then triggers embedding for imported transactions
 */
export class ImportTransactionsProcessor extends BaseProcessor<ImportTransactionsPayload> {
  async process(job: JobContext<ImportTransactionsPayload>): Promise<{
    importedCount: number;
    skippedCount: number;
    invalidCount: number;
  }> {
    const { teamId, filePath, bankAccountId, currency, mappings, inverted } =
      job.data;
    const db = getDb();
    const supabase = createClient();

    this.logger.info("Starting import-transactions job", {
      jobId: job.id,
      teamId,
      filePath: filePath?.join("/"),
      bankAccountId,
      currency,
    });

    if (!filePath) {
      throw new Error("File path is required");
    }

    await this.updateProgress(job, this.ProgressMilestones.FETCHED);

    // Download file from Supabase storage with timeout
    const { data: fileData } = await withTimeout(
      supabase.storage.from("vault").download(filePath.join("/")),
      TIMEOUTS.FILE_DOWNLOAD,
      `File download timed out after ${TIMEOUTS.FILE_DOWNLOAD}ms`,
    );

    const content = await fileData?.text();

    if (!content) {
      throw new Error("File content is required");
    }

    await this.updateProgress(job, 20, undefined, "analyzing");

    const allTransactionIds: string[] = [];
    let totalAttempted = 0;
    let totalInvalid = 0;

    let processedChunks = 0;
    await new Promise<void>((resolve, reject) => {
      // @ts-expect-error - Papa.parse overload resolution issue with string type
      Papa.parse(content, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: () => {
          resolve();
        },
        error: (error: Papa.ParseError) => {
          reject(error);
        },
        chunk: async (
          chunk: {
            data: Record<string, string>[];
            errors: Array<{ message: string }>;
          },
          parser: Papa.Parser,
        ) => {
          parser.pause();

          const { data } = chunk;

          if (!data?.length) {
            throw new Error("No data in CSV import chunk");
          }

          const mappedTransactions = mapTransactions(
            data,
            mappings,
            currency,
            teamId,
            bankAccountId,
          );

          const transformedTransactions = mappedTransactions.map(
            (transaction) => transform({ transaction, inverted }),
          );

          await this.updateProgress(job, 35, undefined, "transforming");

          const { validTransactions, invalidTransactions } =
            // @ts-expect-error - validateTransactions types may not match exactly
            validateTransactions(transformedTransactions);

          await this.updateProgress(job, 45, undefined, "validating");

          if (invalidTransactions.length > 0) {
            this.logger.error("Invalid transactions", {
              invalidTransactions,
            });
          }

          totalAttempted += validTransactions.length;
          totalInvalid += invalidTransactions.length;

          await this.updateProgress(
            job,
            Math.min(75, 50 + processedChunks * 5),
            undefined,
            "importing",
          );

          const totalImportBatches = Math.max(
            1,
            Math.ceil(validTransactions.length / BATCH_SIZE),
          );
          let completedImportBatches = 0;

          // Upsert transactions using db query function
          const results = await processBatch(
            validTransactions,
            BATCH_SIZE,
            async (batch) => {
              // Transform snake_case to camelCase for Drizzle schema
              // Only include fields that exist in the validated transaction
              const transformedBatch = batch.map((t) => ({
                name: t.name,
                date: t.date,
                method: (t.method === "card"
                  ? "card_purchase"
                  : t.method === "bank"
                    ? "transfer"
                    : "other") as "other" | "card_purchase" | "transfer",
                amount: t.amount,
                currency: t.currency,
                teamId: t.team_id,
                bankAccountId: t.bank_account_id ?? null,
                internalId: t.internal_id,
                status: t.status as
                  | "pending"
                  | "completed"
                  | "archived"
                  | "posted"
                  | "excluded",
                manual: t.manual,
                categorySlug: t.category_slug ?? null,
                // Optional fields that may not exist in imported transactions
                description: null,
                balance: null,
                note: null,
                counterpartyName: t.counterparty_name ?? null,
                merchantName: null,
                assignedId: null,
                internal: false,
                notified: true,
                baseAmount: null,
                baseCurrency: null,
                taxAmount: null,
                taxRate: null,
                taxType: null,
                recurring: false,
                frequency: null,
                enrichmentCompleted: false,
              }));

              // Upsert transactions with conflict handling on internalId
              const upserted = await upsertTransactions(db, {
                transactions: transformedBatch,
                teamId,
              });

              completedImportBatches += 1;
              const importingProgress =
                50 +
                Math.round((completedImportBatches / totalImportBatches) * 25);
              await this.updateProgress(
                job,
                Math.min(75, importingProgress),
                undefined,
                "importing",
              );

              return upserted;
            },
          );

          processedChunks += 1;

          // Collect all transaction IDs
          const batchTransactionIds = results
            .flat()
            .map((tx) => tx.id)
            .filter(Boolean);

          allTransactionIds.push(...batchTransactionIds);

          parser.resume();
        },
      });
    });

    await this.updateProgress(job, 80, undefined, "finalizing");

    if (allTransactionIds.length > 0) {
      await enrichTransactions.trigger({
        transactionIds: allTransactionIds,
        teamId,
      });

      await matchTransactionsBidirectional.trigger({
        teamId,
        newTransactionIds: allTransactionIds,
      });

      await this.updateProgress(job, 90, undefined, "enriching");
    }

    await this.updateProgress(job, 100, undefined, "completed");

    const importedCount = allTransactionIds.length;
    const skippedCount = Math.max(0, totalAttempted - importedCount);

    this.logger.info("Import transactions completed", {
      importedCount,
      skippedCount,
      invalidCount: totalInvalid,
      teamId,
    });

    return { importedCount, skippedCount, invalidCount: totalInvalid };
  }
}

const processor = new ImportTransactionsProcessor();

export const importTransactions = schemaTask({
  id: "import-transactions",
  schema: importTransactionsSchema,
  // The import modal watches this run's progress. A large CSV parses in
  // chunks and upserts in batches of 500, so it needs more than the queue's
  // 5 minute stall window allowed for.
  maxDuration: 900,
  queue: { concurrencyLimit: 10 },
  retry: { maxAttempts: 3, minTimeoutInMs: 1000, factor: 2 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "import-transactions", payload, ctx),
});
