import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import { fetchAllInstitutions } from "@midday/banking";
import {
  getActiveInstitutionIds,
  markInstitutionsRemoved,
  upsertInstitutions,
} from "@midday/db/queries";
import { isFlagEnabled } from "@midday/utils/flags";
import { task } from "@trigger.dev/sdk";

type SyncInstitutionsPayload = Record<string, never>;

/**
 * Syncs institutions from banking providers into the PostgreSQL institutions
 * table.
 *
 * Each run:
 * 1. Fetch latest institutions from all providers
 * 2. Upsert new/updated institutions (preserving popularity)
 * 3. Mark removed institutions as status: "removed"
 */
export class SyncInstitutionsProcessor extends BaseProcessor<SyncInstitutionsPayload> {
  async process(
    _job: JobContext<SyncInstitutionsPayload>,
  ): Promise<{ upserted: number; removed: number }> {
    if (!isFlagEnabled("SYNC_INSTITUTIONS_ENABLED")) {
      this.logger.info(
        "Skipping institution sync: SYNC_INSTITUTIONS_ENABLED is off",
      );
      return { upserted: 0, removed: 0 };
    }

    const db = getDb();

    this.logger.info("Starting institution sync");

    // 1. Fetch from all providers
    const { institutions, errors, succeededProviders } =
      await fetchAllInstitutions();

    for (const error of errors) {
      this.logger.error(`Failed to fetch ${error.provider} institutions`, {
        error: error.error,
      });
    }

    if (institutions.length === 0) {
      this.logger.warn(
        "No institutions fetched from any provider, skipping sync",
      );
      return { upserted: 0, removed: 0 };
    }

    this.logger.info(
      `Fetched ${institutions.length} institutions from ${succeededProviders.length} providers (${succeededProviders.join(", ")})`,
    );

    if (errors.length > 0) {
      this.logger.warn(
        `${errors.length} provider(s) failed; removal will only apply to succeeded providers`,
      );
    }

    // 2. Upsert and mark removed in a transaction to prevent inconsistent state
    // Only mark institutions as removed for providers that successfully returned data.
    // This prevents a transient outage of a single provider from incorrectly
    // removing all of that provider's institutions.
    const result = await db.transaction(async (tx) => {
      const upserted = await upsertInstitutions(tx, institutions);

      this.logger.info(`Upserted ${upserted} institutions`);

      const fetchedIds = new Set(institutions.map((i) => i.id));
      const activeIds = await getActiveInstitutionIds(tx, succeededProviders);
      const removedIds = activeIds.filter((id) => !fetchedIds.has(id));
      const removed = await markInstitutionsRemoved(tx, removedIds);

      if (removed > 0) {
        this.logger.info(`Marked ${removed} institutions as removed`);
      }

      return { upserted, removed };
    });

    this.logger.info("Institution sync completed", result);

    return result;
  }
}

const processor = new SyncInstitutionsProcessor();

// Started by hand from Settings → Admin, not on a cron: the list of banks
// barely changes, and a declared schedule costs one of the ten the free plan
// allows even when the run exits immediately on its flag (FF-1521).
//
// Still gated on SYNC_INSTITUTIONS_ENABLED inside the processor.
export const syncInstitutions = task({
  id: "sync-institutions",
  // Fetching every institution from every provider takes a while.
  maxDuration: 600,
  // One at a time: a second run started while the first is still fetching
  // would race it on the same upsert-and-mark-removed transaction.
  queue: { concurrencyLimit: 1 },
  run: (_payload: Record<string, never>, { ctx }) =>
    runProcessor(processor, "sync-institutions", {}, ctx),
});
