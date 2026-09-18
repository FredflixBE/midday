"use client";

import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import { Input } from "@midday/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { FormatAmount } from "@/components/format-amount";
import { useInvalidateTransactionQueries } from "@/hooks/use-invalidate-transaction-queries";
import { useTRPC } from "@/trpc/client";
import { RULE_FIELD_LABELS, type SupplierRuleField } from "./rule-label";

function effectLabel(row: {
  effect: "link" | "move" | "unlink" | "unchanged" | "kept" | "outranked";
  currentSupplier: { name: string } | null;
}): string {
  const current = row.currentSupplier?.name ?? "no supplier";

  switch (row.effect) {
    case "link":
      return "Will be linked";
    case "move":
      return `Will move from ${current}`;
    case "unlink":
      return `Will no longer be ${current}`;
    case "unchanged":
      return "Already linked";
    case "kept":
      return `Stays with ${current} — a person set it`;
    case "outranked":
      return `Stays with ${current} — a more specific rule`;
  }
}

/**
 * Add a rule, seeing what it would take before it is saved (FF-1555).
 *
 * The preview is the point. A rule applies to every payment a person has not
 * decided, past and future, so it lists every payment the text matches —
 * including ones another supplier has today, which would move — before
 * anything changes.
 */
export function RuleEditor({
  supplierId,
  supplierName,
  defaultField = "name",
}: {
  /** Null for a rule saying this text names nobody. */
  supplierId: string | null;
  supplierName?: string;
  defaultField?: SupplierRuleField;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidateTransactions = useInvalidateTransactionQueries();
  const { toast } = useToast();

  const [field, setField] = useState<SupplierRuleField>(defaultField);
  const [value, setValue] = useState("");
  const [debounced] = useDebounceValue(value.trim(), 400);

  const input = { supplierId, field, value: debounced };

  const preview = useQuery({
    ...trpc.suppliers.previewRule.queryOptions(input),
    enabled: debounced.length >= 2,
  });

  const save = useMutation(
    trpc.suppliers.saveRule.mutationOptions({
      onSuccess: ({ applied }) => {
        setValue("");
        invalidateTransactions();
        queryClient.invalidateQueries({
          queryKey: trpc.suppliers.getById.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.suppliers.collectiveRules.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.suppliers.previewRule.queryKey(),
        });

        const changed = applied.linked + applied.moved + applied.unlinked;
        toast({
          duration: 4000,
          variant: "success",
          title: "Rule saved",
          description:
            changed === 0
              ? "No payment changed."
              : `${changed} ${changed === 1 ? "payment" : "payments"} changed.`,
        });
      },
      onError: (error) =>
        toast({
          duration: 5000,
          variant: "error",
          title: "Could not save the rule",
          description: error.message,
        }),
    }),
  );

  const rows = preview.data?.rows ?? [];

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Select
          value={field}
          onValueChange={(next) => setField(next as SupplierRuleField)}
        >
          <SelectTrigger className="w-[220px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(RULE_FIELD_LABELS) as SupplierRuleField[]).map(
              (key) => (
                <SelectItem key={key} value={key}>
                  {RULE_FIELD_LABELS[key]}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>

        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={
            field === "name"
              ? "The words the description starts with"
              : field === "counterparty_iban"
                ? "BE00 0000 0000 0000"
                : "The counterparty, exactly"
          }
          autoComplete="off"
        />

        <Button
          disabled={
            debounced.length < 2 ||
            debounced !== value.trim() ||
            preview.isFetching ||
            save.isPending
          }
          onClick={() => save.mutate(input)}
        >
          Save rule
        </Button>
      </div>

      {debounced.length >= 2 && preview.data ? (
        <div className="border border-border">
          <div className="px-3 py-2 text-xs text-[#878787]">
            {preview.data.total === 0
              ? "No payment matches this yet. It will apply to the ones that arrive."
              : `Matches ${preview.data.total} ${
                  preview.data.total === 1 ? "payment" : "payments"
                }; ${preview.data.changing} would change${
                  supplierId === null
                    ? " — this says the text names nobody"
                    : supplierName
                      ? ` to ${supplierName}`
                      : ""
                }.`}
          </div>

          {rows.length > 0 ? (
            <div className="max-h-72 overflow-auto border-t border-border">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-3 px-3 py-1.5 text-xs"
                >
                  <span className="w-20 shrink-0 text-[#878787]">
                    {formatDate(row.date)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="shrink-0">
                    <FormatAmount amount={row.amount} currency={row.currency} />
                  </span>
                  <span
                    className={cn(
                      "w-72 shrink-0 truncate text-right",
                      row.effect === "move" || row.effect === "unlink"
                        ? "text-[#FF3638]"
                        : row.effect === "link"
                          ? "text-primary"
                          : "text-[#878787]",
                    )}
                  >
                    {effectLabel(row)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
