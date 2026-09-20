"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  formatQuoteVersion,
  type PricingResult,
  priceVersion,
  quoteState,
} from "@midday/quote";
import { Badge } from "@midday/ui/badge";
import { Button } from "@midday/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { DownloadQuotePdf } from "../download-quote-pdf";
import { toProductRates } from "../quote-pricing";
import { useErrorToast } from "../use-error-toast";
import { useQuoteDraft } from "../use-quote-draft";
import { ReadOnlyContext } from "./fields";
import { MarkSentButton, OutcomeMenu } from "./quote-actions";
import { QuoteBlocks } from "./quote-blocks";
import { QuoteComparison } from "./quote-comparison";
import { QuoteHeaderFields, QuoteTitleField } from "./quote-header-fields";
import { QuoteRail } from "./quote-rail";
import { QuoteRates } from "./quote-rates";
import { QuoteScenarios } from "./quote-scenarios";
import { AcceptanceNote, RecordAcceptance } from "./record-acceptance";

type Quote = RouterOutputs["quotes"]["get"];
type Version = Quote["versions"][number];

/**
 * One quote, full page (FF-1611). It opens on the latest version; a draft is
 * edited in place and saved as it changes, a sent version reads only, and
 * Revise is the way to change it. Mark as sent and the outcome are the
 * follow-up (FF-1614).
 */
export function QuoteEditor({ id }: { id: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { data: quote } = useSuspenseQuery(
    trpc.quotes.get.queryOptions({ id }),
  );
  const [versionId, setVersionId] = useState<string | null>(null);

  const latest = quote.versions[0]!;
  const version = quote.versions.find((v) => v.id === versionId) ?? latest;

  const revise = useMutation(
    trpc.quotes.revise.mutationOptions({
      onSuccess: (revised) => {
        queryClient.setQueryData(trpc.quotes.get.queryKey({ id }), revised);
        void queryClient.invalidateQueries({
          queryKey: trpc.quotes.list.queryKey(),
        });
        setVersionId(null);
      },
      onError: errorToast("Not revised"),
    }),
  );

  const canRevise =
    (latest.status === "sent" || latest.status === "superseded") &&
    quote.outcome !== "won";

  // Acceptance answers the version the client holds. An accepted one opens
  // again so what was recorded can be put right.
  const canAccept =
    version.status === "accepted" ||
    (version.status === "sent" && !version.expired);

  return (
    <VersionEditor
      key={version.id}
      quote={quote}
      version={version}
      controls={
        <>
          {quote.versions.length > 1 ? (
            <Select value={version.id} onValueChange={setVersionId}>
              <SelectTrigger aria-label="Version" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {quote.versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    Version {v.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <OutcomeMenu quoteId={quote.id} outcome={quote.outcome} />
          {canAccept ? (
            <RecordAcceptance quoteId={quote.id} version={version} />
          ) : null}
          {canRevise ? (
            <Button
              type="button"
              disabled={revise.isPending}
              onClick={() => revise.mutate({ quoteId: quote.id })}
            >
              Revise
            </Button>
          ) : null}
        </>
      }
    />
  );
}

function VersionEditor({
  quote,
  version,
  controls,
}: {
  quote: Quote;
  version: Version;
  /** The quote's own actions, beside this version's. */
  controls: ReactNode;
}) {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const { draft, change, saved } = useQuoteDraft(quote, version);
  const editable = version.status === "draft";

  const { data: products = [] } = useQuery(
    trpc.productRates.products.queryOptions(),
  );
  const { data: customerRates } = useQuery({
    ...trpc.productRates.customerRates.queryOptions({
      customerId: draft.customerId ?? "",
    }),
    enabled: draft.customerId !== null,
  });

  // A sent version reads from the pricing frozen when it was sent.
  const pricing = useMemo<PricingResult>(
    () =>
      (version.pricing as PricingResult | null) ??
      priceVersion(draft.content, toProductRates(products, customerRates)),
    [version.pricing, draft.content, products, customerRates],
  );

  return (
    <ReadOnlyContext.Provider value={!editable}>
      <div className="mx-auto max-w-[1600px] pb-24">
        {/* Which quote this is, and whether it can be typed into, stay on
            screen the whole way down (FF-1631). The note has a line of its
            own so it can never push the actions off a narrow window. */}
        <div className="sticky top-0 z-30 border-b border-border bg-background pb-3 pt-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="truncate text-lg font-medium">
                {formatQuoteVersion(quote.quoteNumber, version.version)}
              </h1>
              <Badge variant="tag-rounded" className="shrink-0">
                {quoteState(quote, version)}
              </Badge>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {controls}
              <DownloadQuotePdf
                versionId={version.id}
                quoteNumber={quote.quoteNumber}
                version={version.version}
                saved={editable ? saved : undefined}
              />
              {editable ? (
                <MarkSentButton
                  quoteId={quote.id}
                  versionId={version.id}
                  saved={saved}
                />
              ) : null}
            </div>
          </div>
          {quote.outcomeReason || version.acceptedAt ? (
            <div className="mt-1 flex min-w-0 items-center gap-3">
              {quote.outcomeReason ? (
                <span className="truncate text-sm text-[#878787]">
                  {quote.outcomeReason}
                </span>
              ) : null}
              <AcceptanceNote
                version={version}
                trackerProjectId={quote.trackerProjectId}
              />
            </div>
          ) : null}
        </div>

        {/* The document in the middle, what configures it in the rail
            (FF-1630). A narrow window stacks them. */}
        <div className="mt-8 flex flex-col gap-10 xl:flex-row xl:items-start xl:gap-12">
          <main className="min-w-0 flex-1 space-y-10">
            <div className="max-w-2xl">
              <QuoteTitleField
                draft={draft}
                change={change}
                headerLocked={version.version > 1}
                disabled={!editable}
              />
            </div>

            {/* Outside the fieldset: a sent version's text is still read, and
                a block still expands to be read full screen (FF-1624). The
                blocks turn every control of their own off on a sent version. */}
            <QuoteBlocks
              content={draft.content}
              change={change}
              editable={editable}
            />

            {/* Outside the fieldset: a sent version's scenarios are still
                browsed. */}
            <QuoteScenarios
              content={draft.content}
              kind={draft.kind}
              pricing={pricing}
              products={products}
              currency={quote.currency}
              locale={user?.locale ?? undefined}
              editable={editable}
              change={change}
            />

            <QuoteComparison
              content={draft.content}
              kind={draft.kind}
              pricing={pricing}
              currency={quote.currency}
              locale={user?.locale ?? undefined}
            />
          </main>

          <QuoteRail>
            {/* What the client holds names the customer, title, kind and
                language, so a revision shows those locked. */}
            <QuoteHeaderFields
              draft={draft}
              change={change}
              headerLocked={version.version > 1}
              disabled={!editable}
            />

            <QuoteRates
              content={draft.content}
              products={products}
              customerRates={customerRates}
              currency={quote.currency}
              editable={editable}
              change={change}
            />
          </QuoteRail>
        </div>
      </div>
    </ReadOnlyContext.Provider>
  );
}
