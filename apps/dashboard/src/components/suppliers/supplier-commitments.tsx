"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Icons } from "@midday/ui/icons";
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { FormatAmount } from "@/components/format-amount";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";

type Commitment = RouterOutputs["commitments"]["list"][number];

const KINDS = {
  subscription: "Subscription",
  direct_debit: "Direct debit",
  leasing: "Leasing",
  tax: "Tax",
} as const;

const CADENCES = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
} as const;

const STATUSES = {
  active: "Active",
  ended: "Ended",
  rejected: "Not a commitment",
} as const;

/**
 * What this supplier is paid on a rhythm (FF-1591). Detection proposes; a
 * person confirms or rejects, and corrects the kind, the cadence or the status
 * from one menu. A line opens to the payments it is made of, and a payment
 * that is not part of it can be taken out.
 */
export function SupplierCommitments({ supplierId }: { supplierId: string }) {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(
    trpc.commitments.list.queryOptions({ supplierId }),
  );

  if (data.length === 0) return null;

  return (
    <div>
      <h2 className="mb-3 text-lg">Commitments</h2>
      <div className="divide-y divide-border border border-border">
        {data.map((commitment) => (
          <CommitmentRow key={commitment.id} commitment={commitment} />
        ))}
      </div>
    </div>
  );
}

function useCommitmentMutationOptions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return {
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: trpc.commitments.list.queryKey(),
      }),
    onError: (error: { message: string }) =>
      toast({
        duration: 6000,
        variant: "error",
        title: "That did not work",
        description: error.message,
      }),
  };
}

function CommitmentRow({ commitment }: { commitment: Commitment }) {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const options = useCommitmentMutationOptions();
  const [open, setOpen] = useState(false);

  const update = useMutation(trpc.commitments.update.mutationOptions(options));
  const takeOut = useMutation(
    trpc.commitments.setForTransaction.mutationOptions(options),
  );

  const first = commitment.payments[0];
  const settled =
    commitment.status === "rejected" || commitment.status === "ended";

  return (
    <div>
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-3 py-2 text-sm",
          settled && "text-[#878787]",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="min-w-0 truncate text-left"
        >
          {KINDS[commitment.kind]} · <Amount commitment={commitment} />{" "}
          {CADENCES[commitment.cadence].toLowerCase()}
          <span className="text-[#878787]">
            {" · "}
            {commitment.payments.length}{" "}
            {commitment.payments.length === 1 ? "payment" : "payments"}
            {first
              ? ` since ${formatDate(first.date, user?.dateFormat)}`
              : null}
            {commitment.nextDate
              ? ` · next ${formatDate(commitment.nextDate, user?.dateFormat)}`
              : null}
            {commitment.status === "ended" && commitment.endsOn
              ? ` · ended ${formatDate(commitment.endsOn, user?.dateFormat)}`
              : null}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {commitment.status === "proposed" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({ id: commitment.id, status: "active" })
                }
              >
                Confirm
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({ id: commitment.id, status: "rejected" })
                }
              >
                Reject
              </Button>
            </>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Commitment actions"
              >
                <Icons.MoreHoriz className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <Choice
                label="Kind"
                value={commitment.kind}
                options={KINDS}
                onChange={(kind) => update.mutate({ id: commitment.id, kind })}
              />
              <Choice
                label="Cadence"
                value={commitment.cadence}
                options={CADENCES}
                onChange={(cadence) =>
                  update.mutate({ id: commitment.id, cadence })
                }
              />
              <Choice
                label="Status"
                value={commitment.status}
                options={STATUSES}
                onChange={(status) =>
                  update.mutate({ id: commitment.id, status })
                }
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {open ? (
        <div className="border-t border-border bg-[#FAFAF9] dark:bg-[#0C0C0C]">
          {commitment.payments.map((payment) => (
            <div
              key={payment.id}
              className="flex items-center justify-between gap-4 py-1.5 pl-6 pr-3 text-sm"
            >
              <div className="flex min-w-0 items-center gap-4">
                <span className="w-24 shrink-0 text-[#878787]">
                  {formatDate(payment.date, user?.dateFormat)}
                </span>
                <span className="truncate">{payment.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <FormatAmount
                  amount={payment.amount}
                  currency={payment.currency}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={takeOut.isPending}
                  onClick={() =>
                    takeOut.mutate({
                      transactionId: payment.id,
                      commitmentId: null,
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The amount as it is known: exact for a fixed price, the billed price for a
 * foreign one, and a range for usage.
 */
function Amount({ commitment }: { commitment: Commitment }) {
  if (
    commitment.priceKind === "fixed_foreign" &&
    commitment.billedAmount !== null &&
    commitment.billedCurrency
  ) {
    return (
      <FormatAmount
        amount={-commitment.billedAmount}
        currency={commitment.billedCurrency}
      />
    );
  }

  if (
    commitment.priceKind === "usage" &&
    commitment.amountLow !== null &&
    commitment.amountHigh !== null
  ) {
    return (
      <>
        <FormatAmount
          amount={commitment.amountHigh}
          currency={commitment.currency}
        />
        {" to "}
        <FormatAmount
          amount={commitment.amountLow}
          currency={commitment.currency}
        />
      </>
    );
  }

  return (
    <FormatAmount amount={commitment.amount} currency={commitment.currency} />
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => onChange(next as T)}
          >
            {(Object.entries(options) as [T, string][]).map(([key, text]) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {text}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
