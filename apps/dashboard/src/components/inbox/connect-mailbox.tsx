"use client";

import { cn } from "@midday/ui/cn";
import { ConnectGmail } from "./connect-gmail";
import { ConnectOutlook } from "./connect-outlook";
import { SyncStartPicker, useSyncStart } from "./sync-start-picker";

type Props = {
  redirectPath?: string;
  /** The two provider buttons side by side, or one above the other. */
  layout?: "row" | "stacked";
  /**
   * The chosen start date, for a parent that shows it elsewhere. Without it
   * the component keeps its own.
   */
  since?: string;
  onSinceChange?: (since: string) => void;
};

/**
 * Connect a new mailbox: choose how far back its first sync reaches, then the
 * provider. Reconnecting an existing account does not come through here — it
 * carries on from its last sync.
 */
export function ConnectMailbox({
  redirectPath,
  layout = "stacked",
  since: controlledSince,
  onSinceChange,
}: Props) {
  const [ownSince, setOwnSince] = useSyncStart();
  const since = controlledSince ?? ownSince;
  const setSince = onSinceChange ?? setOwnSince;

  return (
    <div className="flex flex-col space-y-3">
      <SyncStartPicker value={since} onChange={setSince} />
      <div
        className={cn(
          "flex",
          layout === "row" ? "flex-row gap-2" : "flex-col space-y-3",
        )}
      >
        <ConnectGmail redirectPath={redirectPath} since={since} />
        <ConnectOutlook redirectPath={redirectPath} since={since} />
      </div>
    </div>
  );
}
