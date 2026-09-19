"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { formatQuoteVersion, quoteState } from "@midday/quote";
import { Badge } from "@midday/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { formatDate } from "@midday/utils/format";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useQueryState } from "nuqs";
import { useDeferredValue } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { DownloadQuotePdf } from "./download-quote-pdf";
import { MODE_LABELS } from "./editor/fields";
import {
  QUOTE_FILTERS,
  type QuoteFilter,
  quoteFilterParser,
  quotesListInput,
} from "./quote-filters";
import { formatQuoteAmount } from "./quote-pricing";

type Row = RouterOutputs["quotes"]["list"][number];

/**
 * Quotes (FF-1614): what was sent, what waits for an answer and what is about
 * to lapse, so the next follow-up is plain. A row opens the quote.
 */
export function QuotesList() {
  const trpc = useTRPC();
  const router = useRouter();
  const { data: user } = useUserQuery();
  const [filter, setFilter] = useQueryState("status", quoteFilterParser);
  // The tab moves at once; the rows follow a deferred copy of the filter, so
  // the ones on screen stay until the new ones are loaded instead of the list
  // suspending on every click. (nuqs's startTransition only covers server
  // updates, and this one is client-side.)
  const shownFilter = useDeferredValue(filter);
  const { data: rows } = useSuspenseQuery(
    trpc.quotes.list.queryOptions(quotesListInput(shownFilter)),
  );

  const date = (value: string | null) =>
    value ? formatDate(value, user?.dateFormat) : "–";

  return (
    <div className="space-y-4">
      <Tabs
        value={filter}
        onValueChange={(next) => setFilter(next as QuoteFilter)}
      >
        <TabsList>
          {(Object.keys(QUOTE_FILTERS) as QuoteFilter[]).map((key) => (
            <TabsTrigger key={key} value={key}>
              {QUOTE_FILTERS[key]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {rows.length === 0 ? (
        <div className="py-16 text-center text-sm text-[#878787]">
          No quotes
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Valid until</TableHead>
              <TableHead className="w-[52px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => router.push(`/quotes/${row.id}`)}
              >
                <TableCell className="whitespace-nowrap">
                  {formatQuoteVersion(row.quoteNumber, row.version.version)}
                </TableCell>
                <TableCell>{row.customerName ?? "–"}</TableCell>
                <TableCell className="max-w-[280px] truncate">
                  {row.title}
                </TableCell>
                <TableCell>
                  <Badge variant="tag">
                    {quoteState(row, row.version, row.held)}
                  </Badge>
                </TableCell>
                <TableCell>{MODE_LABELS[row.version.mode]}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  <Amount row={row} locale={user?.locale ?? undefined} />
                </TableCell>
                {/* What the client holds, even while a revision is drafted. */}
                <TableCell className="whitespace-nowrap">
                  {date(row.held?.sentAt ?? null)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {date(row.held?.validUntil ?? row.version.validUntil)}
                </TableCell>
                {/* The version the number names, like the editor opens on. */}
                <TableCell className="py-0">
                  <DownloadQuotePdf
                    compact
                    versionId={row.version.id}
                    quoteNumber={row.quoteNumber}
                    version={row.version.version}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function Amount({ row, locale }: { row: Row; locale?: string }) {
  if (!row.headline) return <>–</>;
  const amount = formatQuoteAmount(row.headline.amount, row.currency, locale);
  return <>{row.headline.per === "year" ? `${amount} / year` : amount}</>;
}
