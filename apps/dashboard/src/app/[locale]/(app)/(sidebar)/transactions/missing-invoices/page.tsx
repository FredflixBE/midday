import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { MissingInvoicesList } from "@/components/missing-invoices/list";
import { MissingInvoicesSkeleton } from "@/components/missing-invoices/skeleton";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Missing invoices | Midday",
};

/**
 * Its own page rather than a tab on the transactions list.
 *
 * A tab says "the same list, filtered". This is a different job: browsing
 * transactions is looking something up, and clearing missing invoices is working
 * a list until it is empty. FF-1499 shipped it as a tab and it was the wrong
 * furniture (FF-1552).
 */
export default async function MissingInvoices() {
  prefetch(trpc.transactions.missingInvoices.queryOptions());

  return (
    <div className="max-w-screen-lg pt-6">
      <HydrateClient>
        <ErrorBoundary errorComponent={ErrorFallback}>
          <Suspense fallback={<MissingInvoicesSkeleton />}>
            <MissingInvoicesList />
          </Suspense>
        </ErrorBoundary>
      </HydrateClient>
    </div>
  );
}
