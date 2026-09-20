import type { Metadata } from "next";
import { QuoteSettings } from "@/components/quotes/quote-settings";
import { QuoteTerms } from "@/components/quotes/quote-terms";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Quotes | Midday",
};

/** What a quote is priced from lives on Products (FF-1620). */
export default async function Page() {
  prefetch(trpc.quotes.settings.queryOptions());
  prefetch(trpc.quotes.terms.queryOptions());

  return (
    <HydrateClient>
      <div className="space-y-12">
        <QuoteSettings />
        <QuoteTerms />
      </div>
    </HydrateClient>
  );
}
