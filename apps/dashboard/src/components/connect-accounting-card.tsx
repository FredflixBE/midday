"use client";

import { Button } from "@midday/ui/button";
import { Spinner } from "@midday/ui/spinner";
import { useToast } from "@midday/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { BankLogo } from "./bank-logo";

type Props = {
  enabled: boolean;
  /** Called once a card is linked, so the flow can close. */
  onConnected: () => void;
};

/**
 * Cards that no bank will share, offered from the team's own accounting
 * connection (FF-1517).
 *
 * KBC's open-banking consent page offers the current account and not the
 * business Mastercard, so its charges exist nowhere Midday can reach — except
 * in the books, where the accountant enters the card statement every month.
 *
 * **A team without the accounting app sees nothing here.** The query answers
 * with an empty list for one, and an empty list renders nothing at all, so the
 * integration leaves no trace on a screen that has nothing to do with it. A
 * team connects the accounting package itself from the app store first.
 */
export function ConnectAccountingCard({ enabled, onConnected }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data } = useQuery(
    trpc.apps.yukiCardAccounts.queryOptions(undefined, { enabled }),
  );

  const connect = useMutation(
    trpc.apps.connectYukiCard.mutationOptions({
      onSuccess: ({ name }) => {
        queryClient.invalidateQueries({
          queryKey: trpc.bankConnections.get.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.bankAccounts.get.queryKey(),
        });

        toast({
          title: `${name} connected`,
          description:
            "Its charges are being read from your books now. They arrive with the monthly statement, so the newest ones are usually a few weeks old.",
          variant: "success",
        });

        onConnected();
      },
      onError: (error) => {
        toast({
          title: "Could not connect that card",
          description: error.message,
          variant: "error",
        });
      },
    }),
  );

  const accounts = data?.accounts ?? [];

  if (accounts.length === 0) return null;

  return (
    <div className="pb-4 mb-4 border-b">
      <h3 className="text-xs text-[#878787] mb-2">From your accounting</h3>

      <div className="space-y-0.5">
        {accounts.map((account) => {
          const pending =
            connect.isPending &&
            connect.variables?.glAccountCode === account.glAccountCode;

          return (
            <div
              key={account.glAccountCode}
              className="flex justify-between items-center -mx-2 px-2 py-2"
            >
              <div className="flex items-center min-w-0">
                <BankLogo src={account.logoUrl} alt={account.name} />

                <div className="ml-3 min-w-0">
                  <p className="text-sm font-medium leading-none truncate">
                    {account.name}
                  </p>
                  <span className="text-[#878787] text-xs mt-0.5 block">
                    Via your bookkeeping
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                disabled={account.linked || connect.isPending}
                onClick={() =>
                  connect.mutate({ glAccountCode: account.glAccountCode })
                }
              >
                {pending ? (
                  <Spinner className="size-3.5" />
                ) : account.linked ? (
                  "Connected"
                ) : (
                  "Connect"
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
