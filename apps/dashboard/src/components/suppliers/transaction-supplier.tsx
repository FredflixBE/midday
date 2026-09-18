"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import { Label } from "@midday/ui/label";
import { useToast } from "@midday/ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useInvalidateTransactionQueries } from "@/hooks/use-invalidate-transaction-queries";
import { useTRPC } from "@/trpc/client";
import { RuleLabel } from "./rule-label";
import { NO_SUPPLIER, SelectSupplier } from "./select-supplier";

type Transaction = NonNullable<RouterOutputs["transactions"]["getById"]>;

/**
 * Who was paid, and what made it so (FF-1555).
 *
 * The supplier is often the model's answer, and the model will be wrong. So
 * the field says where its value came from — a rule, named; the model on its
 * own; or a person — and a person can always overrule it. Their answer is
 * final: no rule and no enrichment run moves it again.
 */
export function TransactionSupplier({
  transaction,
}: {
  transaction: Pick<
    Transaction,
    "id" | "supplier" | "supplierLink" | "supplierRule"
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

  const set = useMutation(
    trpc.suppliers.setForTransaction.mutationOptions({
      onSuccess: invalidate,
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

      <div className="mt-2 flex items-center justify-between gap-4 text-xs text-[#878787]">
        <Provenance transaction={transaction} />

        {transaction.supplierLink === "person" ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={reset.isPending}
            onClick={() => reset.mutate({ transactionId: transaction.id })}
          >
            Let Midday decide
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Provenance({
  transaction,
}: {
  transaction: Pick<Transaction, "supplier" | "supplierLink" | "supplierRule">;
}) {
  switch (transaction.supplierLink) {
    case "person":
      return <span>Set by a person. Rules will not change it.</span>;
    case "ai":
      return (
        <span>
          Guessed by AI, with no rule behind it. Choose a supplier to confirm or
          correct it.
        </span>
      );
    case "rule":
      return transaction.supplierRule?.id ? (
        <span>
          Matched by rule:{" "}
          <Link
            href={`/transactions/suppliers?supplier=${transaction.supplier?.id}`}
            className="underline underline-offset-2"
          >
            <RuleLabel
              field={transaction.supplierRule.field}
              value={transaction.supplierRule.value}
            />
          </Link>
          {transaction.supplierRule.source === "enrichment"
            ? " — written by AI"
            : null}
        </span>
      ) : (
        <span>Matched by a rule.</span>
      );
    default:
      return <span>No supplier recognised yet.</span>;
  }
}
