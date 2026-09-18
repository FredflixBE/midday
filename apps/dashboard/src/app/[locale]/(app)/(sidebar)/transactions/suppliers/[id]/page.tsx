import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { SupplierDetail } from "@/components/suppliers/supplier-detail";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Supplier | Midday",
};

/**
 * One supplier's page (FF-1555): its settings, payments and rules. Everything
 * it reads is loaded with the page, so it renders once, complete.
 */
export default async function Supplier(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;

  prefetch(trpc.suppliers.list.queryOptions());
  prefetch(trpc.suppliers.getById.queryOptions({ id }));
  prefetch(trpc.suppliers.transactions.queryOptions({ id }));
  prefetch(trpc.transactionCategories.get.queryOptions());

  return (
    <div className="max-w-screen-lg pt-6">
      <HydrateClient>
        <ErrorBoundary errorComponent={ErrorFallback}>
          <Suspense fallback={<div className="h-64" />}>
            <SupplierDetail id={id} />
          </Suspense>
        </ErrorBoundary>
      </HydrateClient>
    </div>
  );
}
