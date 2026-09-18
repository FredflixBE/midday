"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import { Input } from "@midday/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { formatDate } from "@midday/utils/format";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Category } from "@/components/category";
import { FormatAmount } from "@/components/format-amount";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { getColorFromName } from "@/utils/categories";
import { CollectiveNames } from "./collective-names";

type Supplier = RouterOutputs["suppliers"]["list"][number];

type SortKey = "name" | "payments" | "spend" | "lastPayment";
type Sort = { key: SortKey; direction: "asc" | "desc" };

const COMPARE: Record<SortKey, (a: Supplier, b: Supplier) => number> = {
  name: (a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  payments: (a, b) => a.transactionCount - b.transactionCount,
  // Spend is negative, money going out; "more" means further from zero.
  spend: (a, b) =>
    Math.abs(a.spendInBaseCurrency) - Math.abs(b.spendInBaseCurrency),
  lastPayment: (a, b) =>
    (a.lastPaymentDate ?? "").localeCompare(b.lastPaymentDate ?? ""),
};

/**
 * Every supplier in one table, searchable and sortable — by spend above all,
 * which is the question most people open this page with. A row opens the
 * supplier's own page, where its rules, settings and payments are.
 */
export function SuppliersList() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: user } = useUserQuery();
  const { data: suppliers } = useSuspenseQuery(
    trpc.suppliers.list.queryOptions(),
  );

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "spend", direction: "desc" });

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = query
      ? suppliers.filter((supplier) =>
          supplier.name.toLowerCase().includes(query),
        )
      : suppliers;
    const sign = sort.direction === "asc" ? 1 : -1;

    return [...matching].sort(
      (a, b) => sign * COMPARE[sort.key](a, b) || COMPARE.name(a, b),
    );
  }, [suppliers, search, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "name" ? "asc" : "desc" },
    );

  // Start loading a supplier's page before the click lands on it.
  const prefetch = (id: string) => {
    router.prefetch(`/transactions/suppliers/${id}`);
    queryClient.prefetchQuery(trpc.suppliers.getById.queryOptions({ id }));
    queryClient.prefetchQuery(trpc.suppliers.transactions.queryOptions({ id }));
  };

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-serif">Suppliers</h1>
          <p className="mt-1 text-sm text-[#878787]">
            {suppliers.length}{" "}
            {suppliers.length === 1 ? "supplier" : "suppliers"}
          </p>
        </div>
        <Input
          className="w-64"
          placeholder="Search suppliers"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead sortKey="name" sort={sort} onSort={toggleSort}>
              Supplier
            </SortableHead>
            <TableHead>Category</TableHead>
            <SortableHead
              sortKey="payments"
              sort={sort}
              onSort={toggleSort}
              className="text-right"
            >
              Payments
            </SortableHead>
            <SortableHead
              sortKey="spend"
              sort={sort}
              onSort={toggleSort}
              className="text-right"
            >
              Spend
            </SortableHead>
            <SortableHead
              sortKey="lastPayment"
              sort={sort}
              onSort={toggleSort}
              className="text-right"
            >
              Last payment
            </SortableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="py-8 text-center text-[#878787]"
              >
                {suppliers.length === 0
                  ? "No suppliers yet."
                  : "No supplier matches that search."}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((supplier) => (
              <TableRow
                key={supplier.id}
                className="cursor-pointer"
                onMouseEnter={() => prefetch(supplier.id)}
                onClick={() =>
                  router.push(`/transactions/suppliers/${supplier.id}`)
                }
              >
                <TableCell className="max-w-0 truncate">
                  {supplier.name}
                </TableCell>
                <TableCell className="max-w-0">
                  {supplier.category ? (
                    <Category
                      name={supplier.category.name}
                      color={
                        supplier.category.color ??
                        getColorFromName(supplier.category.name)
                      }
                    />
                  ) : supplier.categoryMixed ? (
                    <span className="text-[#878787]">Mixed</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {supplier.transactionCount}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {supplier.spend.map((total, index) => (
                    <span key={total.currency}>
                      {index > 0 ? " + " : null}
                      <FormatAmount
                        amount={total.amount}
                        currency={total.currency}
                        maximumFractionDigits={0}
                      />
                    </span>
                  ))}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap text-[#878787]">
                  {supplier.lastPaymentDate
                    ? formatDate(supplier.lastPaymentDate, user?.dateFormat)
                    : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <CollectiveNames />
    </div>
  );
}

function SortableHead({
  sortKey,
  sort,
  onSort,
  className,
  children,
}: {
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const active = sort.key === sortKey;

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1",
          active ? "text-primary" : "text-[#878787]",
        )}
      >
        {children}
        {active ? (
          sort.direction === "asc" ? (
            <Icons.ArrowUpward className="size-3" />
          ) : (
            <Icons.ArrowDownward className="size-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}
