"use client";

import { Button } from "@midday/ui/button";
import { Label } from "@midday/ui/label";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useInvalidateTransactionQueries } from "@/hooks/use-invalidate-transaction-queries";
import { useTRPC } from "@/trpc/client";
import { RuleEditor } from "./rule-editor";
import { RuleLabel } from "./rule-label";

/**
 * Names that are not a supplier (FF-1555).
 *
 * The accountant files many restaurants under one collective contact —
 * `Diverse leveranciers Restaurant` — and a payment processor prints its own
 * name in front of every merchant. Neither is a company anyone is paid by. A
 * rule here says so, and recognition reads the rest of the payment instead of
 * inventing a supplier that does not exist.
 */
export function CollectiveNames() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidateTransactions = useInvalidateTransactionQueries();
  const { data: rules } = useSuspenseQuery(
    trpc.suppliers.collectiveRules.queryOptions(),
  );

  const deleteRule = useMutation(
    trpc.suppliers.deleteRule.mutationOptions({
      onSuccess: () => {
        invalidateTransactions();
        queryClient.invalidateQueries({
          queryKey: trpc.suppliers.collectiveRules.queryKey(),
        });
      },
    }),
  );

  return (
    <div>
      <Label className="mb-1 block text-base">
        Names that are not a supplier
      </Label>
      <p className="mb-3 text-xs text-[#878787]">
        A collective name the accountant uses for many businesses, or a payment
        processor's. Payments carrying one are recognised from the rest of their
        text instead.
      </p>

      {rules.length > 0 ? (
        <div className="mb-3 divide-y divide-border border border-border">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-4 px-3 py-2 text-xs"
            >
              <RuleLabel field={rule.field} value={rule.value} />
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={deleteRule.isPending}
                onClick={() => deleteRule.mutate({ id: rule.id })}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <RuleEditor supplierId={null} defaultField="counterparty_name" />
    </div>
  );
}
