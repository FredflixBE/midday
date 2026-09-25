"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  formatQuoteVersion,
  type PricingResult,
  priceVersion,
  type QuoteContent,
  quoteState,
} from "@midday/quote";
import { pricingView } from "@midday/quote/view";
import { Badge } from "@midday/ui/badge";
import { Button } from "@midday/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@midday/ui/tabs";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Activity,
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { DownloadQuotePdf } from "../download-quote-pdf";
import { scenarioName, toProductRates } from "../quote-pricing";
import { useErrorToast } from "../use-error-toast";
import { useQuoteDraft } from "../use-quote-draft";
import { ReadOnlyContext } from "./fields";
import { MarkSentButton, OutcomeMenu } from "./quote-actions";
import { QuoteBlocks } from "./quote-blocks";
import { QuoteComparison } from "./quote-comparison";
import { QuoteHeaderFields, QuoteTitleField } from "./quote-header-fields";
import { QuoteRail, RailCard, RailSections, STRIP_HEIGHT } from "./quote-rail";
import { QuoteRates } from "./quote-rates";
import {
  QuoteScenarios,
  ScenarioStepper,
  ScenarioTotals,
} from "./quote-scenarios";
import { AcceptanceNote, RecordAcceptance } from "./record-acceptance";

type Quote = RouterOutputs["quotes"]["get"];
type Product = RouterOutputs["productRates"]["products"][number];
/** What the main column is showing (FF-1639). */
type Pane = "document" | "pricing";
type Version = Quote["versions"][number];

/** One array while the products load, so the memos below hold (FF-1717). */
const NO_PRODUCTS: Product[] = [];
const NO_BLOCKS: QuoteContent["blocks"] = [];

// The panes re-render only when what they show changes (FF-1717).
const DocumentPane = memo(QuoteBlocks);
const ScenariosPane = memo(QuoteScenarios);
const ComparisonPane = memo(QuoteComparison);

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
          <OutcomeMenu
            quoteId={quote.id}
            outcome={quote.outcome}
            acceptedVersionId={
              quote.versions.find((v) => v.status === "accepted")?.id
            }
          />
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

  const { data: products = NO_PRODUCTS } = useQuery(
    trpc.productRates.products.queryOptions(),
  );
  const { data: customerRates } = useQuery({
    ...trpc.productRates.customerRates.queryOptions({
      customerId: draft.customerId ?? "",
    }),
    enabled: draft.customerId !== null,
  });

  // What pricing reads of the content: the scenarios, the rates and the unit,
  // never the text. Built from those alone, it keeps its identity while a
  // text block is typed in, so nothing is re-priced and the Pricing pane's
  // memo holds (FF-1717). Naming every field means a field added to the
  // content has to be placed here, on one side or the other.
  const { scenarios, rates, displayUnit, hoursPerDay } = draft.content;
  const pricingContent = useMemo<QuoteContent>(
    () => ({ blocks: NO_BLOCKS, scenarios, rates, displayUnit, hoursPerDay }),
    [scenarios, rates, displayUnit, hoursPerDay],
  );

  // A sent version reads from the pricing frozen when it was sent.
  const pricing = useMemo<PricingResult>(
    () =>
      (version.pricing as PricingResult | null) ??
      priceVersion(pricingContent, toProductRates(products, customerRates)),
    [version.pricing, pricingContent, products, customerRates],
  );

  const [strip, stripHeight] = useStripHeight();

  // Writing a quote and pricing it are two jobs, and the second is a form
  // (FF-1639). They share the rail, so the figures never leave the screen.
  const [pane, setPane] = useState<Pane>("document");

  // The scenario on show is the page's, so the rail can keep its totals in
  // view while the lines that move them are changed (FF-1632).
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const scenario =
    draft.content.scenarios.find((s) => s.id === scenarioId) ??
    draft.content.scenarios[0];
  const scenarioPricing = pricing.scenarios.find(
    (p) => p.scenarioId === scenario?.id,
  );

  // What the pricing prints, worked out by the same function the PDF is laid
  // out from, so the block standing where it prints can show it (FF-1640).
  const printed = useMemo(
    () =>
      pricingView({
        content: draft.content,
        pricing,
        kind: draft.kind,
        language: draft.language,
        currency: quote.currency,
        productNames: Object.fromEntries(products.map((p) => [p.id, p.name])),
      }),
    [
      draft.content,
      draft.kind,
      draft.language,
      pricing,
      quote.currency,
      products,
    ],
  );

  return (
    <ReadOnlyContext.Provider value={!editable}>
      <div
        // The document and the rail, and nothing between them: 800 + 48 +
        // 380. One width for both tabs, because anything else moves the tab
        // you just clicked out from under the pointer — the priced tables
        // would like more room, and not at that price (FF-1639).
        className="mx-auto max-w-[1228px] pb-24"
        style={{ [STRIP_HEIGHT]: `${stripHeight}px` } as CSSProperties}
      >
        {/* Which quote this is, and whether it can be typed into, stay on
            screen the whole way down (FF-1631). The note has a line of its
            own so it can never push the actions off a narrow window, and the
            actions drop to a line of their own before they overflow. */}
        <div
          ref={strip}
          className="sticky top-0 z-30 border-b border-border bg-background pb-3 pt-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {/* The title leads, and is typed here (FF-1649). It used to be
                set inside the document pane, where it scrolled away and was
                not there at all on the Pricing tab; the strip is the one
                part of the page that stays. The number still identifies the
                quote, it is simply no longer the loudest thing on it. */}
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <QuoteTitleField
                draft={draft}
                change={change}
                headerLocked={version.version > 1}
                disabled={!editable}
              />
              <span className="shrink-0 text-sm text-[#878787]">
                {formatQuoteVersion(quote.quoteNumber, version.version)}
              </span>
              <Badge variant="tag-rounded" className="shrink-0">
                {quoteState(quote, version)}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
          {/* Nothing to say leaves no element behind, and so no line. */}
          <div className="mt-1 flex min-w-0 items-center gap-3 empty:hidden">
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
        </div>

        {/* The document in the middle, what configures it in the rail
            (FF-1630). A narrow window stacks them. */}
        <div className="mt-6 flex flex-col gap-10 xl:flex-row xl:items-start xl:gap-12">
          <main className="min-w-0 flex-1">
            <Tabs
              value={pane}
              // The panes are different lengths, so keeping the scroll
              // would land you in the middle of the shorter one.
              onValueChange={(next) => {
                setPane(next as Pane);
                window.scrollTo({ top: 0 });
              }}
              className="space-y-8"
            >
              <TabsList>
                <TabsTrigger value="document">Document</TabsTrigger>
                <TabsTrigger value="pricing">Pricing</TabsTrigger>
              </TabsList>

              {/* Both panes stay mounted: unmounting an editor throws away
                  its undo history and a half-typed number, neither of which
                  is worth a tab switch. The Pricing pane is also an
                  Activity, so while hidden it keeps its state without
                  rendering alongside every keystroke in the text. The
                  document pane is not: hiding an Activity runs its effects'
                  cleanup, and Tiptap destroys an editor there (FF-1717). */}
              <TabsContent
                value="document"
                forceMount
                className="space-y-10 data-[state=inactive]:hidden"
              >
                {/* Outside the fieldset: a sent version's text is still read,
                    and a block still expands to be read full screen
                    (FF-1624). The blocks turn every control of their own off
                    on a sent version. */}
                <DocumentPane
                  content={draft.content}
                  change={change}
                  editable={editable}
                  pricing={printed}
                />
              </TabsContent>

              <TabsContent
                value="pricing"
                forceMount
                className="space-y-10 data-[state=inactive]:hidden"
              >
                <Activity mode={pane === "pricing" ? "visible" : "hidden"}>
                  {/* Outside the fieldset: a sent version's scenarios are still
                      browsed. */}
                  <ScenariosPane
                    content={pricingContent}
                    kind={draft.kind}
                    products={products}
                    currency={quote.currency}
                    locale={user?.locale ?? undefined}
                    editable={editable}
                    change={change}
                    selected={scenario}
                    pricing={scenarioPricing}
                    onSelect={setScenarioId}
                  />

                  <ComparisonPane
                    content={pricingContent}
                    kind={draft.kind}
                    pricing={pricing}
                    currency={quote.currency}
                    locale={user?.locale ?? undefined}
                  />
                </Activity>
              </TabsContent>
            </Tabs>
          </main>

          <QuoteRail>
            {scenario && scenarioPricing ? (
              <RailCard
                // Named, and steerable, only when there is more than one to
                // tell apart (FF-1673).
                title={
                  draft.content.scenarios.length > 1
                    ? scenarioName(scenario)
                    : undefined
                }
                action={
                  draft.content.scenarios.length > 1 ? (
                    <ScenarioStepper
                      scenarios={draft.content.scenarios}
                      selectedId={scenario.id}
                      onSelect={setScenarioId}
                    />
                  ) : null
                }
              >
                <ScenarioTotals
                  pricing={scenarioPricing}
                  unit={draft.content}
                  products={products}
                  period={scenario.recurrence?.period}
                  currency={quote.currency}
                  locale={user?.locale ?? undefined}
                />
              </RailCard>
            ) : null}

            <RailSections>
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
            </RailSections>
          </QuoteRail>
        </div>
      </div>
    </ReadOnlyContext.Provider>
  );
}

/**
 * How tall the strip stands, published to the page so the rail can stick
 * below it (FF-1631). It is a line taller when a quote has been accepted or
 * answered, so it is measured rather than guessed at from the padding.
 */
function useStripHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const observer = new ResizeObserver(() =>
      setHeight(strip.getBoundingClientRect().height),
    );
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  return [ref, height] as const;
}
