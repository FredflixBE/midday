import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import type { SearchParams } from "nuqs";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { SuppliersList } from "@/components/suppliers/suppliers-list";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Suppliers | Midday",
};

/**
 * Who the business pays, and the rules that recognise them (FF-1555).
 *
 * The rules are first-class here rather than hidden state: this is where each
 * one can be read, corrected or removed, with the payments it linked and how
 * each of them was linked.
 */
export default async function Suppliers(props: {
  searchParams: Promise<SearchParams>;
}) {
  const { supplier } = await props.searchParams;

  prefetch(trpc.suppliers.list.queryOptions());
  prefetch(trpc.suppliers.collectiveRules.queryOptions());

  // A link to one supplier opens it; load its panel with the page so it does
  // not arrive after.
  if (typeof supplier === "string") {
    prefetch(trpc.suppliers.getById.queryOptions({ id: supplier }));
    prefetch(trpc.suppliers.transactions.queryOptions({ id: supplier }));
    prefetch(trpc.transactionCategories.get.queryOptions());
  }

  return (
    <div className="max-w-screen-lg pt-6">
      <HydrateClient>
        <ErrorBoundary errorComponent={ErrorFallback}>
          <Suspense fallback={<div className="h-64" />}>
            <SuppliersList />
          </Suspense>
        </ErrorBoundary>
      </HydrateClient>
    </div>
  );
}
