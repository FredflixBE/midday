"use client";

import { cn } from "@midday/ui/cn";
import { ConnectGmail } from "./connect-gmail";
import { ConnectOutlook } from "./connect-outlook";
import { SyncStartPicker, useSyncStart } from "./sync-start-picker";

type Props = {
  redirectPath?: string;
  /** Classes for the row of provider buttons. */
  className?: string;
};

/**
 * Connect a new mailbox: choose how far back its first sync reaches, then the
 * provider. Reconnecting an existing account does not come through here — it
 * carries on from its last sync.
 */
export function ConnectMailbox({ redirectPath, className }: Props) {
  const [since, setSince] = useSyncStart();

  return (
    <div className="flex flex-col space-y-3">
      <SyncStartPicker value={since} onChange={setSince} />
      <div className={cn("flex flex-col space-y-3", className)}>
        <ConnectGmail redirectPath={redirectPath} since={since} />
        <ConnectOutlook redirectPath={redirectPath} since={since} />
      </div>
    </div>
  );
}
