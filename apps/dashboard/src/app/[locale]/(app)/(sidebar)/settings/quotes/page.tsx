import type { Metadata } from "next";
import { QuoteSettings } from "@/components/quotes/quote-settings";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Quotes | Midday",
};

/** What a quote is priced from lives on Products (FF-1620). */
export default async function Page() {
  prefetch(trpc.quotes.settings.queryOptions());

  return (
    <HydrateClient>
      <QuoteSettings />
    </HydrateClient>
  );
}
