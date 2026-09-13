"use client";

import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@midday/ui/tooltip";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useTransactionParams } from "@/hooks/use-transaction-params";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount } from "@/utils/format";

type Group = ReturnType<typeof useMissingInvoices>["groups"][number];

function useMissingInvoices() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(
    trpc.transactions.missingInvoices.queryOptions(),
  );

  return data;
}

/**
 * The one thing every number on this page has to do: decompose. A count you
 * cannot click into is a claim you cannot check, so the heading says how it is
 * made up and every group states its own share of it.
 */
function Heading({ count, groups }: { count: number; groups: Group[] }) {
  const suppliers = groups.filter((group) => group.key !== null).length;

  return (
    <div className="flex items-end justify-between border-b border-border pb-4">
      <div>
        <h1 className="text-2xl font-medium">Missing invoices</h1>
        <p className="mt-1 text-sm text-[#878787]">
          {count === 0
            ? "Every payment that needs an invoice has one."
            : `${count} ${count === 1 ? "payment" : "payments"} across ${suppliers} ${
                suppliers === 1 ? "supplier" : "suppliers"
              }${groups.some((group) => group.key === null) ? ", plus the ones that name nobody" : ""}.`}
        </p>
      </div>
    </div>
  );
}

/**
 * The accountant's answer, and only where it changes yours. "Your accountant is
 * waiting for this" has consequences; "we cannot tell yet" does not, and a
 * column repeating what every row on this page already says would carry no
 * information at all (FF-1552).
 */
function BooksMarker({ status }: { status: string | null }) {
  if (status !== "invoice_missing") {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-2 inline-flex h-[18px] items-center bg-[#f7f7f7] px-1.5 text-[10px] text-[#878787] dark:bg-[#1d1d1d]">
          Accountant waiting
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs">
        Your accountant has this payment down as still needing an invoice.
      </TooltipContent>
    </Tooltip>
  );
}

function GroupCard({ group }: { group: Group }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { setParams } = useTransactionParams();
  const { data: user } = useUserQuery();

  const noInvoiceNeeded = useMutation(
    trpc.transactions.updateMany.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.transactions.missingInvoices.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.overview.summary.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.transactions.get.infiniteQueryKey(),
        });
      },
    }),
  );

  const totals = group.totals
    .map((total) =>
      formatAmount({
        amount: Math.abs(total.amount),
        currency: total.currency,
        locale: user?.locale,
        maximumFractionDigits: 0,
      }),
    )
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="border border-border">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {group.name ?? "No supplier on the payment"}
          </div>
          <div className="mt-0.5 text-xs text-[#878787]">
            {group.count} {group.count === 1 ? "payment" : "payments"}
            {totals ? ` · ${totals}` : null}
          </div>
        </div>

        {/* One errand per supplier, not per payment. */}
        <Button
          variant="outline"
          size="sm"
          disabled={noInvoiceNeeded.isPending}
          onClick={() =>
            noInvoiceNeeded.mutate({
              ids: group.transactions.map((transaction) => transaction.id),
              status: "completed",
            })
          }
        >
          No invoice needed
        </Button>
      </div>

      <div className="border-t border-border">
        {group.transactions.map((transaction) => (
          <button
            type="button"
            key={transaction.id}
            onClick={() => setParams({ transactionId: transaction.id })}
            className={cn(
              "flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left",
              "border-b border-border last:border-b-0",
              "hover:bg-[#f7f7f7] dark:hover:bg-[#1d1d1d]",
            )}
          >
            <span className="flex min-w-0 items-center">
              <span className="w-[86px] shrink-0 text-xs text-[#878787]">
                {transaction.date}
              </span>
              <span className="truncate text-sm">{transaction.name}</span>
              <BooksMarker status={transaction.booksStatus} />
            </span>
            <span className="shrink-0 text-sm">
              {formatAmount({
                amount: transaction.amount,
                currency: transaction.currency,
                locale: user?.locale,
              })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MissingInvoicesList() {
  const { groups, count } = useMissingInvoices();

  return (
    <div className="flex flex-col gap-6 pb-8">
      <Heading count={count} groups={groups} />

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Icons.Check className="size-8 text-[#878787]" />
          <div className="text-sm font-medium">Nothing to fetch</div>
          <p className="max-w-[360px] text-xs text-[#878787]">
            Payments that can never have a supplier invoice — taxes, owner
            draws, transfers — are not counted here. Categories decide that, and
            you can change the answer per category.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <GroupCard key={group.key ?? "no-supplier"} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
