import { runMaintenanceTaskSchema } from "@api/schemas/admin";
import {
  createTRPCRouter,
  developerProcedure,
  protectedProcedure,
} from "@api/trpc/init";
import { isDeveloper } from "@api/utils/developer";
import {
  getMaintenanceAction,
  maintenanceOptions,
  maintenanceRunKey,
} from "@midday/jobs/maintenance";
import { toTriggeredRun } from "@midday/jobs/run-status";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";

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

      // Validated against the task's own payload schema, so a value this
      // accepts is one the task accepts. A job that takes no options is handed
      // none, whatever was sent for it.
      let options: Record<string, unknown>;
      try {
        options = maintenanceOptions(action, input.options);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error
              ? error.message
              : "Those settings are not valid for this job.",
          cause: error,
        });
      }

      const handle = await tasks.trigger(action.task, options, {
        // The answers are part of the key: two runs of one job with different
        // settings are two different runs, and without this the second press
        // would hand back the first run and look like nothing had changed.
        idempotencyKey: maintenanceRunKey(action, options),
        idempotencyKeyTTL: IDEMPOTENCY_TTL,
      });

      return toTriggeredRun(handle);
    }),
});
