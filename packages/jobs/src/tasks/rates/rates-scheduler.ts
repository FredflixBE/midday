import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import type { RatesSchedulerPayload } from "@jobs/schemas/rates";
import { getRates } from "@midday/banking";
import { upsertExchangeRates } from "@midday/db/queries";
import { isFlagEnabled } from "@midday/utils/flags";
import { schedules } from "@trigger.dev/sdk";

/**
 * Scheduled task that runs twice daily to update exchange rates
 * Fetches rates from the banking API and upserts them to the database
 */
export class RatesSchedulerProcessor extends BaseProcessor<RatesSchedulerPayload> {
  async process(_job: JobContext<RatesSchedulerPayload>): Promise<{
    totalProcessed: number;
    batchesProcessed: number;
  }> {
    if (!isFlagEnabled("RATES_SCHEDULER_ENABLED")) {
      this.logger.info(
        "Skipping rates scheduler: RATES_SCHEDULER_ENABLED is off",
      );
      return { totalProcessed: 0, batchesProcessed: 0 };
    }

    const db = getDb();

    this.logger.info("Starting rates scheduler");

    // Straight to the provider, the way sync-institutions reaches its own.
    // Going through the API meant going through the tRPC client's fetch
    // wrapper, which gives up after 5s — sized for a private-network hop
    // during a redeploy, not for this: getRates() makes one CDN request per
    // currency, 152 of them, and takes about 75 seconds.
    const ratesData = await getRates();

    // Transform rates data to match database schema
    const exchangeRateData = ratesData.flatMap((rate) => {
      return Object.entries(rate.rates).map(([target, value]) => ({
        base: rate.source,
        target: target,
        rate: value,
        updatedAt: rate.date,
      }));
    });

    this.logger.info("Upserting exchange rates", {
      totalRates: exchangeRateData.length,
    });

    // Upsert rates using Drizzle ORM (handles batching internally)
    const result = await upsertExchangeRates(db, {
      rates: exchangeRateData,
      batchSize: 500, // Match original batch size
    });

    this.logger.info("Rates scheduler completed", {
      totalProcessed: result.totalProcessed,
      batchesProcessed: result.batchesProcessed,
    });

    return {
      totalProcessed: result.totalProcessed,
      batchesProcessed: result.batchesProcessed,
    };
  }
}

const processor = new RatesSchedulerProcessor();

// Gated on
// RATES_SCHEDULER_ENABLED inside the processor.
export const ratesScheduler = schedules.task({
  id: "rates-scheduler",
  // Twice daily at 00:00 and 12:00 UTC.
  cron: "0 0,12 * * *",
  maxDuration: 300,
  run: (_payload, { ctx }) =>
    runProcessor(processor, "rates-scheduler", {}, ctx),
});
