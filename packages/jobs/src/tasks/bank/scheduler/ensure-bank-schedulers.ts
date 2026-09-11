import { getDb } from "@jobs/init";
import { generateCronTag } from "@jobs/utils/generate-cron-tag";
import { getTeamsWithBankConnections } from "@midday/db/queries";
import { isFlagEnabled } from "@midday/utils/flags";
import { logger, schedules, task } from "@trigger.dev/sdk";
import { bankSyncScheduler } from "./bank-scheduler";

async function getRegisteredTeamIds(): Promise<Set<string>> {
  const registeredIds = new Set<string>();
  let page = 1;
  let totalPages = 1;

  do {
    const result = await schedules.list({ page, perPage: 200 });
    if (!result?.data) break;

    for (const schedule of result.data) {
      if (
        schedule.task === bankSyncScheduler.id &&
        schedule.externalId &&
        schedule.active
      ) {
        registeredIds.add(schedule.externalId);
      }
    }

    totalPages = result.pagination?.totalPages ?? 1;
    page++;
  } while (page <= totalPages);

  return registeredIds;
}

/** What a run did, for whoever pressed the button in Settings → Admin. */
export interface EnsureBankSchedulersResult {
  /** Teams with at least one bank connection. */
  eligible: number;
  /** Of those, the ones that already had a schedule. */
  registered: number;
  created: number;
  failed: number;
}

const NOTHING_TO_DO: EnsureBankSchedulersResult = {
  eligible: 0,
  registered: 0,
  created: 0,
  failed: 0,
};

// Verifies that every eligible team (pro/starter/active trial with at least one
// bank connection) has a registered bank-sync-scheduler, and creates the ones
// that are missing.
//
// Started by hand from Settings → Admin, not on a cron: it is a safety net for
// a deployment with many teams, connecting a bank already creates the schedule,
// and FF-1501 cleans up properly on deletion. A declared schedule costs one of
// the ten the free plan allows even when its run does nothing (FF-1521).
export const ensureBankSchedulers = task({
  id: "ensure-bank-schedulers",
  maxDuration: 300,
  // One at a time: two concurrent runs would both see the same team as missing
  // a schedule and race to create it.
  queue: { concurrencyLimit: 1 },
  run: async (): Promise<EnsureBankSchedulersResult> => {
    if (!isFlagEnabled("BANK_SYNC_SCHEDULER_ENABLED")) {
      logger.info(
        "Skipping bank scheduler registration: BANK_SYNC_SCHEDULER_ENABLED is off",
      );
      return NOTHING_TO_DO;
    }

    const db = getDb();

    try {
      const [eligibleTeams, registeredTeamIds] = await Promise.all([
        getTeamsWithBankConnections(db),
        getRegisteredTeamIds(),
      ]);

      const missingTeams = eligibleTeams.filter(
        (team) => !registeredTeamIds.has(team.id),
      );

      logger.info("Bank scheduler verification", {
        eligible: eligibleTeams.length,
        registered: registeredTeamIds.size,
        missing: missingTeams.length,
      });

      if (missingTeams.length === 0) {
        return {
          eligible: eligibleTeams.length,
          registered: registeredTeamIds.size,
          created: 0,
          failed: 0,
        };
      }

      let created = 0;
      let failed = 0;

      for (const team of missingTeams) {
        try {
          await schedules.create({
            task: bankSyncScheduler.id,
            cron: generateCronTag(team.id),
            timezone: "UTC",
            externalId: team.id,
            deduplicationKey: `${team.id}-${bankSyncScheduler.id}`,
          });
          created++;
        } catch (error) {
          failed++;
          logger.error("Failed to create scheduler for team", {
            teamId: team.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info("Bank scheduler verification complete", {
        created,
        failed,
      });

      return {
        eligible: eligibleTeams.length,
        registered: registeredTeamIds.size,
        created,
        failed,
      };
    } catch (error) {
      logger.error("Failed to run ensure-bank-schedulers", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw error;
    }
  },
});
