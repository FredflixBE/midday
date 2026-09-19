"use client";

import { Button } from "@midday/ui/button";
import { useCreateQuoteParam } from "./create-quote-dialog";

export function QuotesHeader() {
  const [, setCreate] = useCreateQuoteParam();

  return (
    <div className="flex items-center justify-between">
      <h1 className="text-lg font-medium">Quotes</h1>
      <Button type="button" onClick={() => setCreate(true)}>
        New quote
      </Button>
    </div>
  );
}
