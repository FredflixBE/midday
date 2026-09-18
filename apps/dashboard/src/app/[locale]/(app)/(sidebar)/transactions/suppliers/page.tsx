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
 * The rules are first-class here rather than hidden state: every automatic
 * link on a payment names the rule behind it, and this is where that rule can
 * be read, corrected or removed.
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
