"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import { Label } from "@midday/ui/label";
import { ToastAction } from "@midday/ui/toast";
import { useToast } from "@midday/ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import { useInvalidateTransactionQueries } from "@/hooks/use-invalidate-transaction-queries";
import { useTRPC } from "@/trpc/client";
import { NO_SUPPLIER, SelectSupplier } from "./select-supplier";

type Transaction = NonNullable<RouterOutputs["transactions"]["getById"]>;

/**
 * Who was paid, and what made it so (FF-1555).
 *
 * The supplier is often the model's answer, and the model will be wrong, so
 * a person can always overrule it here. Their answer is final: no rule and no
 * enrichment run moves it again.
 *
 * A correction on one payment is also offered as a rule for its counterparty,
 * so the next payment from the same party is right too — the same gesture as
 * "mark similar transactions", kept instead of applied once and forgotten.
 * Offered, not done: the counterparty may be a collective name the accountant
 * uses for many businesses, and only a person can tell.
 */
export function TransactionSupplier({
  transaction,
}: {
  transaction: Pick<
    Transaction,
    "id" | "supplier" | "supplierLink" | "counterpartyName"
  >;
}) {
  const trpc = useTRPC();
  const invalidate = useInvalidateTransactionQueries();
  const { toast } = useToast();

  const onError = (error: { message: string }) =>
    toast({
      duration: 5000,
      variant: "error",
      title: "Could not change the supplier",
      description: error.message,
    });

  const saveRule = useMutation(
    trpc.suppliers.saveRule.mutationOptions({
      onSuccess: ({ applied }) => {
        invalidate();
        const changed = applied.linked + applied.moved + applied.unlinked;
        toast({
          duration: 4000,
          variant: "success",
          title: "Rule saved",
          description: `${changed} other ${changed === 1 ? "payment" : "payments"} changed. Payments set by a person were left alone.`,
        });
      },
      onError,
    }),
  );

  const set = useMutation(
    trpc.suppliers.setForTransaction.mutationOptions({
      onSuccess: (_, variables) => {
        invalidate();

        const counterparty = transaction.counterpartyName?.trim();
        const chosen = variables.supplierId;
        if (!counterparty || !chosen) return;

        toast({
          duration: 8000,
          title: "Supplier set for this payment",
          description: `Link every payment from "${counterparty}" to this supplier too?`,
          action: (
            <ToastAction
              altText="Make it a rule"
              onClick={() =>
                saveRule.mutate({
                  supplierId: chosen,
                  field: "counterparty_name",
                  value: counterparty,
                })
              }
            >
              Make it a rule
            </ToastAction>
          ),
        });
      },
      onError,
    }),
  );

  const reset = useMutation(
    trpc.suppliers.resetForTransaction.mutationOptions({
      onSuccess: invalidate,
      onError,
    }),
  );

  const supplier = transaction.supplier?.id ? transaction.supplier : null;

  return (
    <div className="mt-6">
      <Label htmlFor="supplier" className="mb-2 block">
        Supplier
      </Label>

      <SelectSupplier
        allowNone
        disabled={set.isPending || reset.isPending}
        selected={
          supplier ??
          (transaction.supplierLink === "person"
            ? { id: NO_SUPPLIER, name: "No supplier" }
            : null)
        }
        onChange={(chosen) =>
          set.mutate({
            transactionId: transaction.id,
            supplierId: chosen?.id ?? null,
          })
        }
      />

      {/* Where the supplier came from is on the Suppliers page — each rule
          with the payments it matched, each payment with how it was linked.
          Repeating it under every field was noise (Frederik, 2026-09-18). */}
      {transaction.supplierLink === "person" ? (
        <div className="mt-1 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-[#878787]"
            disabled={reset.isPending}
            onClick={() => reset.mutate({ transactionId: transaction.id })}
          >
            Let Midday decide
          </Button>
        </div>
      ) : null}
    </div>
  );
}
