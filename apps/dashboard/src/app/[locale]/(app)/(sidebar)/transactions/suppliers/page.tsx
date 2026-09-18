import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
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
 * One table of every supplier, sortable by what was spent with it. A row opens
 * the supplier's page, where its rules can be read, corrected or removed.
 */
export default async function Suppliers() {
  prefetch(trpc.suppliers.list.queryOptions());
  prefetch(trpc.suppliers.collectiveRules.queryOptions());

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
