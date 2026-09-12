import { getDb } from "@jobs/init";
import {
  runYukiDay,
  YUKI_CRON,
  type YukiDayResult,
} from "@jobs/utils/yuki-day";
import { getTeamIdsWithApp } from "@midday/db/queries";
import { YUKI_APP_ID } from "@midday/yuki/team";
import { logger, schedules } from "@trigger.dev/sdk";
import { yukiPullPurchaseInvoices } from "./pull-purchase-invoices";
import { yukiSyncCardCharges } from "./sync-card-charges";

/**
 * **The** Yuki schedule. There is one, and everything Yuki syncs hangs off it.
 *
 * Yuki is connected per team (FF-1516), so the obvious shape is a schedule per
 * team — and that is exactly what there is no room for: the Trigger.dev free
 * plan allows ten, of which four are declared here and two are created per
 * entity at runtime. A schedule per team would spend the rest on the first few
 * teams and then fail to create for the next one.
 *
 * So this fans out over the teams that have the Yuki app instead, and every
 * later Yuki sync becomes another step inside this run rather than another
 * cron. `packages/jobs/src/schedule-budget.test.ts` lists what is declared, so
 * a second Yuki schedule shows up as a diff rather than as a failed deploy.
 *
 * Each step stays a task of its own, so any of them can still be run alone —
 * which is what the button on Settings → Admin and the sync button on the
 * connection both do.
 *
 * The payload is deliberately ignored, so that this also runs correctly when
 * started by hand, which sends none.
 */
export const yukiDaily = schedules.task({
  id: "yuki-daily",
  cron: YUKI_CRON,
  // Waiting on the per-team runs is wall-clock rather than compute, but this
  // task spends almost none of either itself.
  maxDuration: 600,
  // One at a time. A daily schedule cannot overlap itself, but the Admin
  // button can be pressed while a run is going.
  queue: { concurrencyLimit: 1 },
  run: async (): Promise<YukiDayResult> => {
    const teamIds = await getTeamIdsWithApp(getDb(), YUKI_APP_ID);

    logger.info("Yuki day starting", { teams: teamIds.length });

    return runYukiDay(teamIds, async (teamId) => {
      const run = await yukiSyncCardCharges.triggerAndWait({ teamId });

      if (!run.ok) {
        logger.error("Yuki sync failed for a team", { teamId });
      }

      // Started even when the card sync failed, because the two are independent
      // and this is the only thing that starts the pull. Ordered after it only
      // so that the day's new card charges are there to be matched against
      // (FF-1450, FF-1517) — an ordering preference, not a dependency, and a
      // card sync that fails every day must not also mean no invoice is ever
      // pulled again.
      //
      // Started rather than waited for. The pull is bounded, re-runnable and
      // picks up where the last run stopped, so nothing is lost by letting it
      // finish on its own — and the point of there being one Yuki schedule is
      // that the schedule itself stays small.
      try {
        await yukiPullPurchaseInvoices.trigger({ teamId });
      } catch (error) {
        // Failing to start the pull does not undo the card sync, and tomorrow's
        // run starts it again.
        logger.error("Could not start the Yuki invoice pull for a team", {
          teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      return run.ok ? { ok: true, output: run.output } : { ok: false };
    });
  },
});
