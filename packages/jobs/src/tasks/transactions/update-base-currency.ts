import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type UpdateBaseCurrencyPayload,
  updateBaseCurrencySchema,
} from "@jobs/schemas/transactions";
import { withDbConnectionRetry } from "@jobs/utils/db-retry";
import { getBankAccounts } from "@midday/db/queries";
import { schemaTask } from "@trigger.dev/sdk";
import { updateAccountBaseCurrency } from "./update-account-base-currency";

/**
 * Updates base currency for a team
 * Fetches all enabled accounts and triggers update-account-base-currency for each
 */
export class UpdateBaseCurrencyProcessor extends BaseProcessor<UpdateBaseCurrencyPayload> {
  async process(job: JobContext<UpdateBaseCurrencyPayload>): Promise<void> {
    const { teamId, baseCurrency } = job.data;
    const db = getDb();

    this.logger.info("Starting update-base-currency job", {
      jobId: job.id,
      teamId,
      baseCurrency,
    });

    await this.updateProgress(job, 5);

    // Get all enabled accounts
    const accounts = await withDbConnectionRetry(
      () =>
        getBankAccounts(db, {
          teamId,
          enabled: true,
        }),
      {
        operationName: "getBankAccounts(update-base-currency)",
        logger: this.logger,
      },
    );

    if (!accounts || accounts.length === 0) {
      this.logger.info("No enabled accounts found", { teamId });
      await this.updateProgress(job, 100);
      return;
    }

    await this.updateProgress(job, 15);

    this.logger.info("Updating base currency for accounts", {
      teamId,
      accountCount: accounts.length,
      baseCurrency,
    });

    // Trigger update-account-base-currency jobs sequentially
    // Use Promise.all for parallel execution but with proper error handling
    const accountUpdates = accounts.map((account) =>
      updateAccountBaseCurrency.trigger({
        accountId: account.id,
        currency: account.currency || "USD",
        balance: Number(account.balance) || 0,
        baseCurrency,
      }),
    );

    await this.updateProgress(job, 25);

    // Wait for all account updates to complete
    const results = await Promise.allSettled(accountUpdates);

    // Calculate progress based on completed accounts
    const completedCount = results.filter(
      (result) => result.status === "fulfilled",
    ).length;
    const accountProgress = Math.min(
      90,
      25 + Math.round((completedCount / accounts.length) * 65),
    );

    await this.updateProgress(job, accountProgress);

    await this.updateProgress(job, 100);

    this.logger.info("Update base currency completed", {
      teamId,
      accountCount: accounts.length,
      baseCurrency,
    });
  }
}

const processor = new UpdateBaseCurrencyProcessor();

export const updateBaseCurrency = schemaTask({
  id: "update-base-currency",
  schema: updateBaseCurrencySchema,
  maxDuration: 300,
  queue: { concurrencyLimit: 10 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "update-base-currency", payload, ctx),
});
