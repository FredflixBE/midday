import { getDb } from "@jobs/init";
import {
  type YukiPullInvoicesPayload,
  yukiPullInvoicesSchema,
} from "@jobs/schemas/yuki";
import { runYukiDay, type YukiDayResult } from "@jobs/utils/yuki-day";
import { getTeamIdsWithApp } from "@midday/db/queries";
import { YUKI_APP_ID } from "@midday/yuki/team";
import { logger, schemaTask } from "@trigger.dev/sdk";
import { yukiPullPurchaseInvoices } from "./pull-purchase-invoices";

/**
 * The pull, across every team that has connected Yuki (FF-1541).
 *
 * One task rather than a loop inside the schedule, because this is the thing a
 * person starts by hand. The backlog on the first run is a few hundred
 * documents at fifty a run, so somebody wants to start it, watch it, and start
 * it again — and widening the cutoff later is exactly the kind of decision made
 * once, deliberately, while looking at the result.
 *
 * It waits for each team so that the run it hands back says what actually
 * happened: how many invoices arrived, and how many are still to come. A
 * fire-and-forget fan-out would answer "started" and nothing else, which is not
 * an answer anybody presses a button for.
 */
export const yukiPullInvoices = schemaTask({
  id: "yuki-pull-invoices",
  schema: yukiPullInvoicesSchema,
  // Waiting on the per-team runs is wall-clock rather than compute, and this
  // task spends almost none of either itself — the same reasoning `daily.ts`
  // runs under, and the same number.
  maxDuration: 600,
  // One at a time. Every run is safe to repeat — the reference id is unique —
  // but two at once would fetch the same documents twice.
  queue: { concurrencyLimit: 1 },
  // A failure here is a connection problem or a changed Yuki response, and
  // neither improves by asking again immediately. Nothing is lost by waiting:
  // anything a run left half-done is finished by the next one.
  retry: { maxAttempts: 1 },
  run: async ({
    cutoff,
    limit,
  }: YukiPullInvoicesPayload): Promise<YukiDayResult> => {
    const teamIds = await getTeamIdsWithApp(getDb(), YUKI_APP_ID);

    logger.info("Pulling Yuki invoices", {
      teams: teamIds.length,
      cutoff,
      limit,
    });

    // Team by team, and a team that fails does not stop the others — the same
    // rule the Yuki day runs under, and the same helper.
    return runYukiDay(teamIds, async (teamId) => {
      const run = await yukiPullPurchaseInvoices.triggerAndWait({
        teamId,
        cutoff,
        limit,
      });

      if (!run.ok) {
        logger.error("Yuki invoice pull failed for a team", { teamId });
        return { ok: false };
      }

      return { ok: true, output: run.output };
    });
  },
});
