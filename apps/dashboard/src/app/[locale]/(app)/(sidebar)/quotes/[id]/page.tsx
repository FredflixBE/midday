import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { QuoteEditor } from "@/components/quotes/editor/quote-editor";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Quote | Midday",
};

/** One quote in the editor (FF-1611), with the products it prices from. */
export default async function Quote(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;

  prefetch(trpc.quotes.get.queryOptions({ id }));
  prefetch(trpc.productRates.products.queryOptions());

  return (
    <HydrateClient>
      <ErrorBoundary errorComponent={ErrorFallback}>
        <Suspense fallback={<div className="h-64" />}>
          <QuoteEditor id={id} />
        </Suspense>
      </ErrorBoundary>
    </HydrateClient>
  );
}
