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
});

export type RunMaintenanceTaskInput = z.infer<typeof runMaintenanceTaskSchema>;
