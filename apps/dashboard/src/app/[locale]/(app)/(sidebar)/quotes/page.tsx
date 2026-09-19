import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import type { SearchParams } from "nuqs/server";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { CreateQuoteDialog } from "@/components/quotes/create-quote-dialog";
import {
  loadQuoteFilter,
  quotesListInput,
} from "@/components/quotes/quote-filters";
import { QuotesHeader } from "@/components/quotes/quotes-header";
import { QuotesList } from "@/components/quotes/quotes-list";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Quotes | Midday",
};

/** Quotes (FF-1606): the list with its follow-up filters, and a new one. */
export default async function Quotes(props: {
  searchParams: Promise<SearchParams>;
}) {
  const { status } = loadQuoteFilter(await props.searchParams);
  prefetch(trpc.quotes.list.queryOptions(quotesListInput(status)));

  return (
    <HydrateClient>
      <div className="max-w-screen-xl space-y-6 pt-6">
        <QuotesHeader />
        <ErrorBoundary errorComponent={ErrorFallback}>
          <Suspense fallback={<div className="h-64" />}>
            <QuotesList />
          </Suspense>
        </ErrorBoundary>
        <CreateQuoteDialog />
      </div>
    </HydrateClient>
  );
}
