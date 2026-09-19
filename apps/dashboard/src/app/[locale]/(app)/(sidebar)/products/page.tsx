import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { ProductsSkeleton } from "@/components/tables/products/skeleton";
import { DataTable } from "@/components/tables/products/table";
import { prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Products | Midday",
};

/**
 * Products (FF-1620): what the team sells. An invoice line and a quote line
 * both pick from here; on a quote, the price is the hourly rate.
 */
export default function Page() {
  prefetch(
    trpc.invoiceProducts.get.queryOptions({
      sortBy: "recent",
      limit: 100,
      includeInactive: true,
    }),
  );

  return (
    <div className="max-w-screen-lg pt-6">
      <ErrorBoundary errorComponent={ErrorFallback}>
        <Suspense fallback={<ProductsSkeleton />}>
          <DataTable />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
