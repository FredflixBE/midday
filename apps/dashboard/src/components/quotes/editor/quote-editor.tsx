"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  formatQuoteVersion,
  type PricingResult,
  priceVersion,
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
import { useMemo, useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { toWorkTypeRates } from "../quote-pricing";
import { useErrorToast } from "../use-error-toast";
import { useQuoteDraft } from "../use-quote-draft";
import { ReadOnlyContext } from "./fields";
import { QuoteBlocks } from "./quote-blocks";
import { QuoteComparison } from "./quote-comparison";
import { QuoteHeaderFields } from "./quote-header-fields";
import { QuoteRates } from "./quote-rates";
import { QuoteScenarios } from "./quote-scenarios";

type Quote = RouterOutputs["quotes"]["get"];
type Version = Quote["versions"][number];

const STATUS_LABELS: Record<Version["status"], string> = {
  draft: "Draft",
  sent: "Sent",
  superseded: "Superseded",
  accepted: "Accepted",
};

/**
 * One quote, full page (FF-1611). It opens on the latest version; a draft is
 * edited in place and saved as it changes, a sent version reads only, and
 * Revise is the way to change it.
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
        setVersionId(null);
      },
      onError: errorToast("Not revised"),
    }),
  );

  const canRevise = latest.status === "sent" || latest.status === "superseded";

  return (
    <div className="max-w-screen-xl space-y-10 pb-24 pt-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-medium">
            {formatQuoteVersion(quote.quoteNumber, version.version)}
          </h1>
          <Badge variant="tag">
            {version.expired ? "Expired" : STATUS_LABELS[version.status]}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {quote.versions.length > 1 ? (
            <Select value={version.id} onValueChange={setVersionId}>
              <SelectTrigger aria-label="Version" className="w-[160px]">
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
          {canRevise ? (
            <Button
              type="button"
              disabled={revise.isPending}
              onClick={() => revise.mutate({ quoteId: quote.id })}
            >
              Revise
            </Button>
          ) : null}
        </div>
      </div>

      <VersionEditor key={version.id} quote={quote} version={version} />
    </div>
  );
}

function VersionEditor({ quote, version }: { quote: Quote; version: Version }) {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const { draft, change } = useQuoteDraft(quote, version);
  const editable = version.status === "draft";

  const { data: workTypes = [] } = useQuery(
    trpc.workTypes.list.queryOptions({ includeArchived: true }),
  );
  const { data: customerRates } = useQuery({
    ...trpc.workTypes.customerRates.queryOptions({
      customerId: draft.customerId ?? "",
    }),
    enabled: draft.customerId !== null,
  });

  // A sent version reads from the pricing frozen when it was sent.
  const pricing = useMemo<PricingResult>(
    () =>
      (version.pricing as PricingResult | null) ??
      priceVersion(draft.content, toWorkTypeRates(workTypes, customerRates)),
    [version.pricing, draft.content, workTypes, customerRates],
  );

  return (
    <ReadOnlyContext.Provider value={!editable}>
      <div className="space-y-10">
        <fieldset disabled={!editable} className="min-w-0 space-y-10">
          <QuoteHeaderFields
            draft={draft}
            change={change}
            // What the client holds names the customer, title, kind and language.
            headerLocked={version.version > 1}
            disabled={!editable}
          />

          <QuoteBlocks
            content={draft.content}
            change={change}
            editable={editable}
          />

          <QuoteRates
            content={draft.content}
            workTypes={workTypes}
            customerRates={customerRates}
            editable={editable}
            change={change}
          />
        </fieldset>

        {/* Outside the fieldset: a sent version's scenarios are still browsed. */}
        <QuoteScenarios
          content={draft.content}
          kind={draft.kind}
          pricing={pricing}
          workTypes={workTypes}
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
      </div>
    </ReadOnlyContext.Provider>
  );
}
