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
import { Checkbox } from "@midday/ui/checkbox";
import { Icons } from "@midday/ui/icons";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Category } from "@/components/category";
import { FormatAmount } from "@/components/format-amount";
import { BulkEditBar } from "@/components/tables/transactions/bulk-edit-bar";
import { useInvalidateTransactionQueries } from "@/hooks/use-invalidate-transaction-queries";
import { useTransactionParams } from "@/hooks/use-transaction-params";
import { useUserQuery } from "@/hooks/use-user";
import { useTransactionsStore } from "@/store/transactions";
import { useTRPC } from "@/trpc/client";
import { getColorFromName } from "@/utils/categories";
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
 * One supplier: its settings, its payments and the rules that recognise it,
 * with the two things that end it — a merge into the supplier it turned out
 * to be, or deletion. The charts and documents come with FF-1588.
 */
export function SupplierDetail({ id }: { id: string }) {
  const trpc = useTRPC();
  const { data: suppliers } = useSuspenseQuery(
    trpc.suppliers.list.queryOptions(),
  );
  const supplier = suppliers.find((row) => row.id === id);

  if (!supplier) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-[#878787]">
          This supplier no longer exists. It may have been merged into another.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="space-y-4 border-b border-border pb-4">
        <BackLink />
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-2xl font-serif">{supplier.name}</h1>
            {supplier.source !== "manual" ? (
              <span className="shrink-0 border border-border px-1.5 text-[10px] text-[#878787]">
                AI
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <MergeSupplier supplier={supplier} />
            <DeleteSupplier supplier={supplier} />
          </div>
        </div>
      </div>

      <SupplierSettings supplier={supplier} />
      <SupplierPayments supplierId={supplier.id} />
      <SupplierRules supplier={supplier} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/transactions/suppliers"
      className="inline-flex items-center gap-1 text-sm text-[#878787] hover:text-primary"
    >
      <Icons.ArrowBack className="size-4" />
      Suppliers
    </Link>
  );
}

function SupplierSettings({ supplier }: { supplier: Supplier }) {
  const trpc = useTRPC();
  const options = useSupplierMutationOptions();
  const [name, setName] = useState(supplier.name);
  const update = useMutation(trpc.suppliers.update.mutationOptions(options));

  const invoiceChoice =
    supplier.canHaveSupplierInvoice === true
      ? "always"
      : supplier.canHaveSupplierInvoice === false
        ? "never"
        : "category";

  return (
    <div className="grid grid-cols-2 gap-4">
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
        <Label className="mb-2 block">Invoices</Label>
        <Select
          value={invoiceChoice}
          onValueChange={(choice) =>
            update.mutate({
              id: supplier.id,
              canHaveSupplierInvoice:
                choice === "always" ? true : choice === "never" ? false : null,
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
      </div>
    </div>
  );
}

function SupplierRules({ supplier }: { supplier: Supplier }) {
  const trpc = useTRPC();
  const options = useSupplierMutationOptions();
  const { data } = useSuspenseQuery(
    trpc.suppliers.getById.queryOptions({ id: supplier.id }),
  );
  const deleteRule = useMutation(
    trpc.suppliers.deleteRule.mutationOptions(options),
  );

  return (
    <div>
      <h2 className="mb-3 text-lg">Rules</h2>

      {data.rules.length ? (
        <div className="mb-3 divide-y divide-border border border-border">
          {data.rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
            >
              <div className="min-w-0 truncate">
                <RuleLabel field={rule.field} value={rule.value} />
                <span className="text-[#878787]">
                  {" · "}
                  {rule.matchedCount}{" "}
                  {rule.matchedCount === 1 ? "payment" : "payments"}
                  {rule.source === "enrichment" ? " · AI" : null}
                </span>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
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
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </div>
      ) : null}

      <RuleEditor supplierId={supplier.id} supplierName={supplier.name} />
    </div>
  );
}

function MergeSupplier({ supplier }: { supplier: Supplier }) {
  const trpc = useTRPC();
  const router = useRouter();
  const options = useSupplierMutationOptions();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(
    null,
  );

  const merge = useMutation(
    trpc.suppliers.merge.mutationOptions({
      ...options,
      onSuccess: (_, variables) => {
        options.onSuccess();
        setTarget(null);
        router.push(`/transactions/suppliers/${variables.targetId}`);
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
  const router = useRouter();
  const options = useSupplierMutationOptions();
  const remove = useMutation(
    trpc.suppliers.delete.mutationOptions({
      ...options,
      onSuccess: () => {
        options.onSuccess();
        router.push("/transactions/suppliers");
      },
    }),
  );

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={remove.isPending}>
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
  rule: "Rule",
  ai: "AI guess",
  person: "Manual",
} as const;

/**
 * The rows behind the supplier's payment count, and where a supplier's
 * category is fixed: select payments and recategorise them with the same bulk
 * bar the transactions table uses. The category lives on the payment; the
 * supplier only reads it back (FF-1555, 2026-09-18).
 */
function SupplierPayments({ supplierId }: { supplierId: string }) {
  const trpc = useTRPC();
  const { setParams } = useTransactionParams();
  const { data: user } = useUserQuery();
  const { data } = useSuspenseQuery(
    trpc.suppliers.transactions.queryOptions({ id: supplierId }),
  );

  // The transactions table's own selection, so its bulk bar works unchanged.
  // Cleared on the way in and out: it is shared with that table, and a
  // selection made on one page must not act on the other.
  const { rowSelectionByTab, setRowSelection, setCanDelete } =
    useTransactionsStore();
  const selection = rowSelectionByTab.all;

  useEffect(() => {
    setRowSelection("all", {});
    return () => setRowSelection("all", {});
  }, [setRowSelection]);

  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const allSelected = data.length > 0 && selectedIds.length === data.length;

  // Only a manually added payment can be deleted, as on the transactions table.
  useEffect(() => {
    const selected = data.filter((row) => selection[row.id]);
    setCanDelete(selected.length > 0 && selected.every((row) => row.manual));
  }, [data, selection, setCanDelete]);

  const toggle = (id: string, checked: boolean) =>
    setRowSelection("all", (current) => {
      const next = { ...current };
      if (checked) next[id] = true;
      else delete next[id];
      return next;
    });

  const toggleAll = (checked: boolean) =>
    setRowSelection(
      "all",
      checked ? Object.fromEntries(data.map((row) => [row.id, true])) : {},
    );

  return (
    <div>
      <h2 className="mb-3 text-lg">Payments</h2>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-12 px-0">
              <CheckboxBox>
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  disabled={data.length === 0}
                />
              </CheckboxBox>
            </TableHead>
            <TableHead className="w-32">Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-48">Category</TableHead>
            <TableHead className="w-36 text-right">Amount</TableHead>
            <TableHead className="w-28 text-right">Linked</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="py-8 text-center text-[#878787]"
              >
                No payments yet.
              </TableCell>
            </TableRow>
          ) : (
            data.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                data-state={selection[row.id] ? "selected" : undefined}
                onClick={() => setParams({ transactionId: row.id })}
              >
                <TableCell
                  className="w-12 px-0"
                  onClick={(event) => event.stopPropagation()}
                >
                  <CheckboxBox>
                    <Checkbox
                      checked={Boolean(selection[row.id])}
                      onCheckedChange={(checked) =>
                        toggle(row.id, checked === true)
                      }
                    />
                  </CheckboxBox>
                </TableCell>
                <TableCell className="whitespace-nowrap text-[#878787]">
                  {formatDate(row.date, user?.dateFormat)}
                </TableCell>
                <TableCell className="max-w-0 truncate">{row.name}</TableCell>
                <TableCell className="max-w-0">
                  {row.category?.slug ? (
                    <Category
                      name={row.category.name}
                      color={
                        row.category.color ??
                        getColorFromName(row.category.name)
                      }
                    />
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <FormatAmount amount={row.amount} currency={row.currency} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-right text-[#878787]">
                  {row.supplierLink ? LINK_LABELS[row.supplierLink] : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <BulkEditBar />
    </div>
  );
}

/**
 * A checkbox centred in its cell at a fixed height. Inline, it sits on the
 * text line and the tick makes that line — and the row — taller; the table's
 * own cell style also drops the right padding around a checkbox, which pulls
 * it off centre.
 */
function CheckboxBox({ children }: { children: React.ReactNode }) {
  return <div className="flex h-5 items-center justify-center">{children}</div>;
}
