"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";
import { useSuspenseQuery } from "@tanstack/react-query";
import { differenceInDays, formatDistanceToNow } from "date-fns";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useReconnect } from "@/hooks/use-reconnect";
import { useTRPC } from "@/trpc/client";
import { connectionStatus } from "@/utils/connection-status";
import { BankAccount } from "./bank-account";
import { BankLogo } from "./bank-logo";
import { DeleteConnection } from "./delete-connection";
import { AddBankAccountsModal } from "./modals/add-bank-accounts-modal";
import { ReconnectProvider } from "./reconnect-provider";
import { SyncTransactions } from "./sync-transactions";

function getProviderName(provider: string | null) {
  switch (provider) {
    case "gocardless":
      return "GoCardLess";
    case "enablebanking":
      return "Enable Banking";
    case "yuki":
      // Never named to the user as the accounting package it is: this is a
      // bank connection like any other, and the wording stays Midday's.
      return "your bookkeeping";
    default:
      return null;
  }
}

type BankConnection = NonNullable<
  RouterOutputs["bankConnections"]["get"]
>[number];

function ConnectionState({
  connection,
  isSyncing,
}: {
  connection: BankConnection;
  isSyncing: boolean;
}) {
  const { show, expired } = connectionStatus(connection);

  if (isSyncing) {
    return (
      <div className="text-xs font-normal flex items-center space-x-1">
        <span>Syncing...</span>
      </div>
    );
  }

  if (connection.status === "disconnected") {
    return (
      <>
        <div className="text-xs font-normal flex items-center space-x-1 text-[#c33839]">
          <Icons.AlertCircle />
          <span>Connection issue</span>
        </div>

        <TooltipContent
          className="px-3 py-1.5 text-xs max-w-[430px]"
          sideOffset={20}
          side="left"
        >
          Please reconnect to restore the connection to a good state.
        </TooltipContent>
      </>
    );
  }

  if (show && !expired) {
    return (
      <>
        <div className="text-xs font-normal flex items-center space-x-1 text-[#FFD02B]">
          <Icons.AlertCircle />
          <span>Connection expires soon</span>
        </div>

        {connection.expiresAt && (
          <TooltipContent
            className="px-3 py-1.5 text-xs max-w-[430px]"
            sideOffset={20}
            side="left"
          >
            We only have access to your bank for another{" "}
            {differenceInDays(new Date(connection.expiresAt), new Date())} days.
            Please update the connection to keep everything in sync.
          </TooltipContent>
        )}
      </>
    );
  }

  if (expired) {
    return (
      <div className="text-xs font-normal flex items-center space-x-1 text-[#c33839]">
        <Icons.Error />
        <span>Connection expired</span>
      </div>
    );
  }

  if (connection.lastAccessed) {
    return (
      <div className="text-xs font-normal flex items-center space-x-1">
        <span className="text-xs font-normal">{`Updated ${formatDistanceToNow(
          new Date(connection.lastAccessed),
          {
            addSuffix: true,
          },
        )}`}</span>
        <span>via {getProviderName(connection.provider)}</span>
      </div>
    );
  }

  return <div className="text-xs font-normal">Never accessed</div>;
}

export function BankConnection({ connection }: { connection: BankConnection }) {
  const { show } = connectionStatus(connection);
  const [isAddAccountsOpen, setAddAccountsOpen] = useState(false);

  // All reconnect/sync logic is encapsulated in the useReconnect hook
  const { isSyncing, triggerReconnect, triggerManualSync } = useReconnect({
    connectionId: connection.id,
    provider: connection.provider,
  });

  // Handle completion from ReconnectProvider - route to appropriate action
  const handleComplete = (type: "reconnect" | "sync") => {
    if (type === "reconnect") {
      triggerReconnect();
    } else {
      triggerManualSync();
    }
  };

  const isConnected = connection.status === "connected" && !show;

  // A card read out of the books has no open-banking provider behind it, so
  // there is nothing to reconnect and no further account to discover — the
  // card is the account. Syncing and deleting still mean exactly what they
  // mean everywhere else.
  const readFromBooks = connection.provider === "yuki";

  return (
    <div className="py-4">
      <div className="flex justify-between items-center">
        <div className="flex space-x-4 items-center w-full">
          <BankLogo src={connection.logoUrl} alt={connection.name} />

          <div className="flex flex-col">
            <span className="text-sm">{connection.name}</span>

            <TooltipProvider delayDuration={70}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <ConnectionState
                      connection={connection}
                      isSyncing={isSyncing}
                    />
                  </div>
                </TooltipTrigger>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        <div className="ml-auto flex space-x-2 items-center">
          {connection.status === "disconnected" || show ? (
            <>
              {!readFromBooks && (
                <ReconnectProvider
                  variant="button"
                  id={connection.id}
                  provider={connection.provider}
                  institutionId={connection.institutionId}
                  onComplete={handleComplete}
                  referenceId={connection.referenceId}
                />
              )}
              <DeleteConnection connection={connection} />
            </>
          ) : (
            <>
              {!readFromBooks && (
                <ReconnectProvider
                  id={connection.id}
                  provider={connection.provider}
                  institutionId={connection.institutionId}
                  onComplete={handleComplete}
                  referenceId={connection.referenceId}
                />
              )}

              {isConnected && !readFromBooks && (
                <TooltipProvider delayDuration={70}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="rounded-full w-7 h-7 flex items-center"
                        onClick={() => setAddAccountsOpen(true)}
                      >
                        <Plus size={16} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent
                      className="px-3 py-1.5 text-xs"
                      sideOffset={10}
                    >
                      Add accounts
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}

              <SyncTransactions
                disabled={isSyncing}
                onClick={triggerManualSync}
              />
              <DeleteConnection connection={connection} />
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {connection.bankAccounts.map((account) => {
          return (
            <BankAccount
              key={account.id}
              data={account}
              provider={connection.provider}
            />
          );
        })}
      </div>

      {!readFromBooks && (
        <AddBankAccountsModal
          connectionId={connection.id}
          provider={connection.provider as "gocardless" | "enablebanking"}
          accessToken={connection.accessToken}
          referenceId={connection.referenceId}
          enrollmentId={connection.enrollmentId}
          institutionId={connection.institutionId}
          existingAccounts={connection.bankAccounts}
          isOpen={isAddAccountsOpen}
          onOpenChange={setAddAccountsOpen}
          onAccountsAdded={triggerManualSync}
        />
      )}
    </div>
  );
}

export function BankConnections() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.bankConnections.get.queryOptions());

  return (
    <div className="divide-y">
      {data?.map((connection) => {
        return <BankConnection key={connection.id} connection={connection} />;
      })}
    </div>
  );
}
