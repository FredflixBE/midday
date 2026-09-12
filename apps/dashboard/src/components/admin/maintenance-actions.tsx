import { MAINTENANCE_ACTION_IDS } from "@midday/jobs/maintenance";
import { MaintenanceActionCard } from "./maintenance-action-card";

/**
 * The maintenance jobs that used to run on a cron, now started by hand
 * (FF-1521). The list comes from `@midday/jobs/maintenance`, so a new job
 * appears here without touching this file.
 *
 * Only the id crosses into the card, which looks the rest up for itself. This
 * is a server component and a maintenance action carries a `summarize`
 * function, which cannot be serialised across that boundary — passing the
 * whole action threw on every render of this page (FF-1525).
 */
export function MaintenanceActions() {
  return (
    <div className="space-y-12">
      {MAINTENANCE_ACTION_IDS.map((id) => (
        <MaintenanceActionCard key={id} id={id} />
      ))}
    </div>
  );
}
