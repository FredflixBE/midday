"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useState } from "react";
import { useTRPC } from "@/trpc/client";
import { CollectiveNames } from "./collective-names";
import { SupplierPanel } from "./supplier-panel";

type Supplier = RouterOutputs["suppliers"]["list"][number];

/**
 * Everything the panel reads. Loaded before a panel opens, so it opens once
 * at its full height rather than growing as each section arrives.
 */
function useSupplierPanelQueries() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const getById = (id: string) => trpc.suppliers.getById.queryOptions({ id });
  const payments = (id: string) =>
    trpc.suppliers.transactions.queryOptions({ id });
  const categories = trpc.transactionCategories.get.queryOptions();

  return {
    prefetch: (id: string) => {
      queryClient.prefetchQuery(getById(id));
      queryClient.prefetchQuery(payments(id));
      queryClient.prefetchQuery(categories);
    },
    ensure: (id: string) =>
      Promise.all([
        queryClient.ensureQueryData(getById(id)),
        queryClient.ensureQueryData(payments(id)),
        queryClient.ensureQueryData(categories),
      ]),
  };
}

/**
 * Every supplier, with the numbers behind it — how many payments point at it
 * and how many rules recognise it — each one opening onto the rows it counts
 * (FF-1555's third rule: an aggregate you cannot click into is a claim you
 * cannot check).
 */
export function SuppliersList() {
  const trpc = useTRPC();
  const { data: suppliers } = useSuspenseQuery(
    trpc.suppliers.list.queryOptions(),
  );
  const [open, setOpen] = useQueryState("supplier", parseAsString);
  const panel = useSupplierPanelQueries();
  // The supplier being loaded before its panel opens.
  const [opening, setOpening] = useState<string | null>(null);

  const toggle = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }

    setOpening(id);
    try {
      await panel.ensure(id);
    } finally {
      setOpening(null);
    }
    setOpen(id);
  };

  const byAi = suppliers.filter((supplier) => supplier.source !== "manual");

  return (
    <div className="space-y-8">
      <div className="border-b border-border pb-4">
        <h1 className="text-2xl font-serif">Suppliers</h1>
        <p className="mt-1 text-sm text-[#878787]">
          {suppliers.length === 0
            ? "No suppliers yet. They appear as payments are recognised, or you can pick one on any payment."
            : `${suppliers.length} ${suppliers.length === 1 ? "supplier" : "suppliers"}${
                byAi.length > 0 ? `, ${byAi.length} of them created by AI` : ""
              }. Each is recognised by its rules; a payment someone set by hand is never moved by one.`}
        </p>
      </div>

      {suppliers.length > 0 ? (
        <div className="border border-border divide-y divide-border">
          {suppliers.map((supplier) => (
            <SupplierRow
              key={supplier.id}
              supplier={supplier}
              isOpen={open === supplier.id}
              isOpening={opening === supplier.id}
              onToggle={() => toggle(supplier.id)}
              onIntent={() => panel.prefetch(supplier.id)}
            />
          ))}
        </div>
      ) : null}

      <CollectiveNames />
    </div>
  );
}

function SupplierRow({
  supplier,
  isOpen,
  isOpening,
  onToggle,
  onIntent,
}: {
  supplier: Supplier;
  isOpen: boolean;
  isOpening: boolean;
  onToggle: () => void;
  /** Hover or focus: start loading the panel before the click. */
  onIntent: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        onMouseEnter={onIntent}
        onFocus={onIntent}
        aria-busy={isOpening}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-accent"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{supplier.name}</span>
            {supplier.source !== "manual" ? (
              <span className="shrink-0 border border-border px-1.5 text-[10px] font-normal text-[#878787]">
                AI
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-[#878787]">
            {supplier.transactionCount}{" "}
            {supplier.transactionCount === 1 ? "payment" : "payments"} ·{" "}
            {supplier.ruleCount} {supplier.ruleCount === 1 ? "rule" : "rules"}
            {supplier.defaultCategory?.name
              ? ` · ${supplier.defaultCategory.name}`
              : null}
            {supplier.canHaveSupplierInvoice === false
              ? " · never sends invoices"
              : supplier.canHaveSupplierInvoice === true
                ? " · always sends invoices"
                : null}
          </div>
        </div>
        <Icons.ChevronDown
          className={cn(
            "size-4 shrink-0 text-[#878787] transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen ? (
        // Its own boundary, so a panel opened straight from a link does not
        // take the whole list down to the page's fallback while it loads.
        <Suspense fallback={null}>
          <SupplierPanel supplier={supplier} />
        </Suspense>
      ) : null}
    </div>
  );
}
