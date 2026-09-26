"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@midday/ui/alert-dialog";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import { ToastAction } from "@midday/ui/toast";
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { FormatAmount } from "@/components/format-amount";
import { DownloadBooksZip } from "@/components/missing-invoices/download-books-zip";
import { useTransactionParams } from "@/hooks/use-transaction-params";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount } from "@/utils/format";

type MissingInvoices = RouterOutputs["transactions"]["missingInvoices"];
type Group = MissingInvoices["groups"][number];

/**
 * The one thing every number on this page has to do: decompose. A count you
 * cannot click into is a claim you cannot check, so the heading says how it is
 * made up and every group states its own share of it.
 */
function Heading({ count, readyToConfirm, groups }: MissingInvoices) {
  const suppliers = groups.filter((group) => group.key !== null).length;
  const hasNoSupplier = groups.some((group) => group.key === null);

  return (
    <div className="border-b border-border pb-4">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-serif">Missing invoices</h1>
        <DownloadBooksZip />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {count === 0
          ? "Every payment that needs an invoice has one."
          : `${count} ${count === 1 ? "payment" : "payments"} across ${suppliers} ${
              suppliers === 1 ? "supplier" : "suppliers"
            }${hasNoSupplier ? ", plus the ones with no supplier" : ""}.`}
      </p>
      {readyToConfirm > 0 ? (
        <p className="mt-1 text-sm">
          {readyToConfirm} of them already{" "}
          {readyToConfirm === 1 ? "has" : "have"} an invoice waiting on a yes.
        </p>
      ) : null}
    </div>
  );
}

function Marker({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className="ml-2 inline-flex h-[18px] shrink-0 items-center bg-muted px-1.5 text-[10px] text-muted-foreground"
    >
      {children}
    </span>
  );
}

function GroupCard({ group }: { group: Group }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { setParams } = useTransactionParams();
  const { data: user } = useUserQuery();

  const update = useMutation(
    trpc.transactions.updateMany.mutationOptions({
      onSuccess: (_, variables) => {
        // Every place that shows this number or this row. The page's own count,
        // the overview card, the transactions list, and the sheet a row opens —
        // which this page can have open while the row leaves the list.
        for (const queryKey of [
          trpc.transactions.missingInvoices.queryKey(),
          trpc.overview.summary.queryKey(),
          trpc.transactions.get.infiniteQueryKey(),
          trpc.transactions.getById.queryKey(),
        ]) {
          queryClient.invalidateQueries({ queryKey });
        }

        const payments = `${variables.ids.length} ${
          variables.ids.length === 1 ? "payment" : "payments"
        }`;

        // Putting them back is the same call in the other direction, so the
        // toast can carry it. Without this the only way back is a bulk action
        // under a menu called Export, which is not something anyone finds by
        // looking — and a group leaving the list is exactly the kind of change
        // you notice one second after making it.
        if (variables.status === "completed") {
          toast({
            duration: 10000,
            title: "No invoice needed",
            description: `${payments} from ${group.name ?? "payments with no supplier"} left the list.`,
            footer: (
              <div className="mt-4 flex space-x-2">
                <ToastAction
                  altText="Undo"
                  className="pl-5 pr-5"
                  onClick={() =>
                    update.mutate({ ids: variables.ids, status: "posted" })
                  }
                >
                  Undo
                </ToastAction>
              </div>
            ),
          });

          return;
        }

        toast({
          title: `${payments} back on the list.`,
          variant: "success",
          duration: 3500,
        });
      },
      onError: () => {
        toast({
          title: "Something went wrong please try again.",
          variant: "error",
          duration: 3500,
        });
      },
    }),
  );

  const ids = group.transactions.map((transaction) => transaction.id);
  const dismiss = () => update.mutate({ ids, status: "completed" });

  // One payment is a small mistake with an undo on it. A dozen is worth a
  // sentence first, because the button acts on the whole group at once.
  const asksFirst = group.count > 3;

  // Signed, like the rows underneath, and per currency. A group's money is only
  // ever a statement about its own rows — never a net across currencies, and
  // never an unsigned number over signed ones.
  const totals = group.totals
    .map((total) =>
      formatAmount({
        amount: total.amount,
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
            {group.name ?? "No supplier"}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {group.count} {group.count === 1 ? "payment" : "payments"}
            {group.readyToConfirm > 0
              ? ` · ${group.readyToConfirm} to confirm`
              : null}
            {totals ? ` · ${totals}` : null}
          </div>
        </div>

        {/* One errand per supplier, not per payment. The payments with no
            supplier are many parties, so there is nothing to mark at once. */}
        {group.supplierId === null ? null : asksFirst ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={update.isPending}>
                No invoice needed
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Mark {group.count} payments as needing no invoice?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Every payment under {group.name} leaves this list. Nothing is
                  deleted and your reports do not change — you are saying these
                  will never have a supplier invoice. You can put them back.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={dismiss}>
                  Mark {group.count} payments
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={update.isPending}
            onClick={dismiss}
          >
            No invoice needed
          </Button>
        )}
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
              "hover:bg-accent",
            )}
          >
            <span className="flex min-w-0 items-center">
              <span className="w-[100px] shrink-0 text-xs text-muted-foreground">
                {formatDate(transaction.date, user?.dateFormat)}
              </span>
              <span className="truncate text-sm">{transaction.name}</span>

              {/*
               * Two markers, and both change what you would do. A suggestion is
               * one click; a payment the books have settled is a trip to the
               * books rather than to the supplier.
               *
               * "Settled", not "your accountant has the invoice" (FF-1568). The
               * books close an item with or without a document — a taxi ride
               * with no receipt goes to a collective creditor and is closed
               * because nothing is coming — and Yuki does not say which. Both
               * readings send you to the books; only the old one could be false.
               *
               * The books agreeing with this page — "still needs an invoice" —
               * is deliberately not marked. It is true of nearly every row here
               * by definition, so it read as noise on all of them and told you
               * nothing about any of them: the same mistake as a column
               * repeating the page's own title, wearing a badge.
               *
               * Plain text with a title rather than a tooltip: these sit inside
               * the row's own button, and a tooltip trigger nested in a button is
               * unreachable by keyboard.
               */}
              {transaction.hasSuggestion ? (
                <Marker title="Midday found a likely invoice for this payment. Open it to confirm or reject the match.">
                  Invoice suggested
                </Marker>
              ) : null}
              {transaction.booksStatus === "in_the_books" ? (
                <Marker title="Your accountant has settled this payment in the books, with or without an invoice. Look in the books before asking the supplier.">
                  Settled in the books
                </Marker>
              ) : null}
            </span>
            <span className="shrink-0 text-sm">
              <FormatAmount
                amount={transaction.amount}
                currency={transaction.currency}
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MissingInvoicesList() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(
    trpc.transactions.missingInvoices.queryOptions(),
  );

  return (
    <div className="flex flex-col gap-6 pb-8">
      <Heading
        count={data.count}
        readyToConfirm={data.readyToConfirm}
        groups={data.groups}
      />

      {data.groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Icons.Check className="size-8 text-muted-foreground" />
          <div className="text-sm font-medium">Nothing to fetch</div>
          <p className="max-w-[360px] text-xs text-muted-foreground">
            Payments that can never have a supplier invoice — taxes, owner
            draws, transfers — are not counted here. Categories decide that, and
            you can change the answer per category.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {data.groups.map((group) => (
            <GroupCard key={group.key ?? "no-supplier"} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
