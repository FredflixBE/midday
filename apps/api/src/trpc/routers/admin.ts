import { runMaintenanceTaskSchema } from "@api/schemas/admin";
import {
  createTRPCRouter,
  developerProcedure,
  protectedProcedure,
} from "@api/trpc/init";
import { isDeveloper } from "@api/utils/developer";
import { getMaintenanceAction } from "@midday/jobs/maintenance";
import { toTriggeredRun } from "@midday/jobs/run-status";
import { tasks } from "@trigger.dev/sdk";

/**
 * How long a maintenance run's idempotency key lives.
 *
 * Long enough that a double-click, or a page reload followed by a second
 * press, lands on the run that is already going rather than starting a rival
 * one. Short enough that someone who wants to run the job again after reading
 * its result does not have to wait. Overlap beyond this window is stopped by
 * the tasks themselves, which each take a queue of one.
 */
const IDEMPOTENCY_TTL = "5m";

export const adminRouter = createTRPCRouter({
  /**
   * Whether the caller is the developer of this installation, which is what
   * decides if the Admin tab appears at all.
   *
   * Open to any signed-in member on purpose: the answer is about the caller,
   * and a member who cannot see the tab still has to be told that, rather than
   * left staring at a request that never resolves.
   */
  isDeveloper: protectedProcedure.query(({ ctx: { session } }) =>
    isDeveloper(session.user.email),
  ),

  /**
   * Start a maintenance job and hand back the run, so the dashboard can follow
   * it and show what it did.
   *
   * These jobs are deployment-wide rather than team-scoped — they have no
   * `teamId` and touch rows no single team owns — which is why the run comes
   * back with its own public access token instead of being readable through
   * `jobs.getStatus`, and why only the developer may start one.
   */
  runMaintenanceTask: developerProcedure
    .input(runMaintenanceTaskSchema)
    .mutation(async ({ input }) => {
      const action = getMaintenanceAction(input.action);

      const handle = await tasks.trigger(
        action.task,
        {},
        {
          idempotencyKey: `maintenance:${action.id}`,
          idempotencyKeyTTL: IDEMPOTENCY_TTL,
        },
      );

      return toTriggeredRun(handle);
    }),
});
