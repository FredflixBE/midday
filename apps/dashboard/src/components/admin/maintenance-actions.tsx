import { MAINTENANCE_ACTIONS } from "@midday/jobs/maintenance";
import { MaintenanceActionCard } from "./maintenance-action-card";

/**
 * The maintenance jobs that used to run on a cron, now started by hand
 * (FF-1521). The list comes from `@midday/jobs/maintenance`, so a new job
 * appears here without touching this file.
 */
export function MaintenanceActions() {
  return (
    <div className="space-y-12">
      {MAINTENANCE_ACTIONS.map((action) => (
        <MaintenanceActionCard key={action.id} action={action} />
      ))}
    </div>
  );
}
