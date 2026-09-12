import { MAINTENANCE_ACTION_IDS } from "@midday/jobs/maintenance";
import { z } from "zod";

/**
 * Which maintenance job Settings → Admin wants started.
 *
 * The ids come from the shared registry, so an action the dashboard does not
 * know about cannot be requested, and adding one needs no edit here.
 */
export const runMaintenanceTaskSchema = z.object({
  action: z.enum(MAINTENANCE_ACTION_IDS),
  /**
   * What the job was asked to run with, for the few that take anything.
   *
   * Loose here on purpose: the real rules are the task's own payload schema,
   * which the router runs this through (`maintenanceOptions`). Restating them
   * would be a second opinion about what each job accepts, and the two would
   * drift the first time a bound moved.
   */
  options: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type RunMaintenanceTaskInput = z.infer<typeof runMaintenanceTaskSchema>;
