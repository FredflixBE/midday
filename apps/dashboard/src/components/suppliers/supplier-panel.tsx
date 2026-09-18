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
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { FormatAmount } from "@/components/format-amount";
import { SelectCategory } from "@/components/select-category";
import { useInvalidateTransactionQueries } from "@/hooks/use-invalidate-transaction-queries";
import { useTransactionParams } from "@/hooks/use-transaction-params";
import { useTRPC } from "@/trpc/client";
import { RuleEditor } from "./rule-editor";
import { RuleLabel } from "./rule-label";
import { SelectSupplier } from "./select-supplier";

type Supplier = RouterOutputs["suppliers"]["list"][number];

const INVOICE_CHOICES = {
  category: "The category decides",
  always: "Always sends an invoice",
  never: "Never sends an invoice",
} as const;

function useSupplierMutationOptions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidateTransactions = useInvalidateTransactionQueries();
  const { toast } = useToast();

  return {
    onSuccess: () => {
      invalidateTransactions();
      queryClient.invalidateQueries({
        queryKey: trpc.suppliers.getById.queryKey(),
      });
    },
    onError: (error: { message: string }) =>
      toast({
        duration: 6000,
        variant: "error",
        title: "That did not work",
        description: error.message,
      }),
  };
}

/**
 * One supplier's defaults, its rules, and the two things that end it: a merge
 * into the supplier it turned out to be, or deletion.
 */
export function SupplierPanel({ supplier }: { supplier: Supplier }) {
  const trpc = useTRPC();
  const options = useSupplierMutationOptions();
  // Suspense rather than a loading state: the list loads these before it
  // opens the panel (`supplierPanelQueries`), so the panel renders complete
  // instead of growing section by section while it opens.
  const { data } = useSuspenseQuery(
    trpc.suppliers.getById.queryOptions({ id: supplier.id }),
  );

  const [name, setName] = useState(supplier.name);

  const update = useMutation(trpc.suppliers.update.mutationOptions(options));
  const deleteRule = useMutation(
    trpc.suppliers.deleteRule.mutationOptions(options),
  );

  const invoiceChoice =
    supplier.canHaveSupplierInvoice === true
      ? "always"
      : supplier.canHaveSupplierInvoice === false
        ? "never"
        : "category";

  return (
    <div className="space-y-6 border-t border-border bg-accent/30 px-4 py-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label className="mb-2 block">Name</Label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name.trim() && name.trim() !== supplier.name) {
                update.mutate(
                  { id: supplier.id, name: name.trim() },
                  { onError: () => setName(supplier.name) },
                );
              }
            }}
          />
        </div>

        <div>
          <Label className="mb-2 block">Usual category</Label>
          <SelectCategory
            // @ts-expect-error - the list's category has no children
            selected={
              supplier.defaultCategory?.id
                ? supplier.defaultCategory
                : undefined
            }
            hideLoading
            onChange={(category) =>
              update.mutate({ id: supplier.id, defaultCategoryId: category.id })
            }
          />
          <p className="mt-1 text-xs text-[#878787]">
            Given to new payments that have none. A payment can still differ.
          </p>
        </div>

        <div>
          <Label className="mb-2 block">Invoices</Label>
          <Select
            value={invoiceChoice}
            onValueChange={(choice) =>
              update.mutate({
                id: supplier.id,
                canHaveSupplierInvoice:
                  choice === "always"
                    ? true
                    : choice === "never"
                      ? false
                      : null,
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(INVOICE_CHOICES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-[#878787]">
            Whether its payments belong on Missing invoices.
          </p>
        </div>
      </div>

      <div>
        <Label className="mb-2 block">Rules</Label>
        <p className="mb-3 text-xs text-[#878787]">
          A payment is this supplier's when a rule matches it. The account
          number is read first, then the counterparty, then the start of the
          description, where the longest match wins. Saving or deleting a rule
          re-links past payments too, except the ones a person set.
        </p>

        {data.rules.length ? (
          <div className="mb-3 divide-y divide-border border border-border">
            {data.rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between gap-4 px-3 py-2 text-xs"
              >
                <div className="min-w-0 truncate">
                  <RuleLabel field={rule.field} value={rule.value} />
                  <span className="text-[#878787]">
                    {" · "}
                    {rule.matchedCount}{" "}
                    {rule.matchedCount === 1 ? "payment" : "payments"}
                    {rule.source === "enrichment" ? " · written by AI" : null}
                  </span>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={deleteRule.isPending}
                    >
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {rule.matchedCount === 0
                          ? "No payment is linked by it."
                          : `${rule.matchedCount} ${rule.matchedCount === 1 ? "payment is" : "payments are"} linked by it. They are recognised again: another rule may take them, and otherwise they are left with no supplier.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteRule.mutate({ id: rule.id })}
                      >
                        Delete rule
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-xs text-[#878787]">
            No rules. Only payments someone linked by hand point here.
          </p>
        )}

        <RuleEditor supplierId={supplier.id} supplierName={supplier.name} />
      </div>

      <SupplierPayments supplierId={supplier.id} />

      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <span className="text-xs text-[#878787]">
          {supplier.source === "manual"
            ? "Created by a person."
            : "Created by AI from a payment it recognised."}
        </span>

        <div className="flex gap-2">
          <MergeSupplier supplier={supplier} />
          <DeleteSupplier supplier={supplier} />
        </div>
      </div>
    </div>
  );
}

function MergeSupplier({ supplier }: { supplier: Supplier }) {
  const trpc = useTRPC();
  const options = useSupplierMutationOptions();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(
    null,
  );

  const merge = useMutation(
    trpc.suppliers.merge.mutationOptions({
      ...options,
      onSuccess: () => {
        options.onSuccess();
        setTarget(null);
      },
    }),
  );

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => !open && setTarget(null)}
    >
      <div className="w-56">
        <SelectSupplier
          placeholder="Merge into…"
          allowCreate={false}
          exclude={[supplier.id]}
          onChange={(chosen) => setTarget(chosen)}
        />
      </div>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Merge {supplier.name} into {target?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its {supplier.transactionCount}{" "}
            {supplier.transactionCount === 1 ? "payment" : "payments"} and{" "}
            {supplier.ruleCount} {supplier.ruleCount === 1 ? "rule" : "rules"}{" "}
            move to {target?.name}, and {supplier.name} goes away. Payments set
            by a person stay set by a person. {target?.name} keeps its own name
            and settings, taking {supplier.name}'s only where it has none.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={merge.isPending}
            onClick={() =>
              target &&
              merge.mutate({ sourceId: supplier.id, targetId: target.id })
            }
          >
            Merge
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteSupplier({ supplier }: { supplier: Supplier }) {
  const trpc = useTRPC();
  const options = useSupplierMutationOptions();
  const remove = useMutation(trpc.suppliers.delete.mutationOptions(options));

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={remove.isPending}>
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {supplier.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its rules are deleted, and its {supplier.transactionCount}{" "}
            {supplier.transactionCount === 1 ? "payment goes" : "payments go"}{" "}
            back to being recognised — including ones a person set. If it is the
            same company as another supplier, merge it instead: that keeps its
            payments together.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => remove.mutate({ id: supplier.id })}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const LINK_LABELS = {
  rule: "by rule",
  ai: "AI guess",
  person: "set by a person",
} as const;

/** The rows behind the supplier's payment count, each opening its sheet. */
function SupplierPayments({ supplierId }: { supplierId: string }) {
  const trpc = useTRPC();
  const { setParams } = useTransactionParams();
  const { data } = useSuspenseQuery(
    trpc.suppliers.transactions.queryOptions({ id: supplierId }),
  );

  if (data.length === 0) return null;

  return (
    <div>
      <Label className="mb-2 block">Payments</Label>
      <div className="max-h-72 divide-y divide-border overflow-auto border border-border">
        {data.map((row) => (
          <button
            type="button"
            key={row.id}
            onClick={() => setParams({ transactionId: row.id })}
            className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-accent"
          >
            <span className="w-20 shrink-0 text-[#878787]">
              {formatDate(row.date)}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="shrink-0">
              <FormatAmount amount={row.amount} currency={row.currency} />
            </span>
            <span className="w-28 shrink-0 text-right text-[#878787]">
              {row.supplierLink ? LINK_LABELS[row.supplierLink] : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
