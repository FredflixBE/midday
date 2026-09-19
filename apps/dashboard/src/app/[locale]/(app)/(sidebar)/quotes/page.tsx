import type { Metadata } from "next";
import { CreateQuoteDialog } from "@/components/quotes/create-quote-dialog";
import { QuotesHeader } from "@/components/quotes/quotes-header";

export const metadata: Metadata = {
  title: "Quotes | Midday",
};

/** Quotes (FF-1606): a new one starts here; the list is FF-1614's. */
export default function Quotes() {
  return (
    <div className="max-w-screen-xl pt-6">
      <QuotesHeader />
      <CreateQuoteDialog />
    </div>
  );
}
