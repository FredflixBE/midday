import type { ImageSource } from "@midday/invoice/templates/pdf/format";
import type { EditorNode } from "@midday/invoice/types";
import { compareScenarios } from "../compare";
import type {
  EditorDoc,
  ItemLine,
  QuoteContent,
  QuoteKind,
  Recurrence,
  Scenario,
} from "../content";
import { formatQuoteVersion } from "../number";
import type { Amount, PricingResult, ScenarioPricing } from "../pricing";
import { amountInUnit, rateInUnit } from "../unit";
import {
  fill,
  type QuoteLabels,
  type QuoteLanguage,
  quoteLabels,
} from "./labels";

/**
 * What a quote PDF says, in order (FF-1613, docs/quotes.md §6), worked out
 * from a version and its pricing as plain text, so the template only lays it
 * out. A sent version is priced from its frozen `pricing`, a draft from a
 * live calculation; either way it arrives here as a `PricingResult`.
 *
 * - Every quantity is in the version's unit, hours or days, and every rate
 *   is per that unit (FF-1619).
 * - A rate is the one charged: the discount that led to it is not shown.
 * - Optional items are listed apart from the scenario, with their price.
 * - Contract value is internal and never printed.
 */

export type QuotePdfInput = {
  quoteNumber: string;
  title: string;
  kind: QuoteKind;
  language: QuoteLanguage;
  currency: string;
  version: number;
  mode: "estimate" | "firm";
  /** `YYYY-MM-DD`. */
  issueDate: string;
  validUntil: string;
  fromDetails: unknown;
  customerDetails: unknown;
  content: QuoteContent;
  pricing: PricingResult;
  /** Product names by id; a line names its product. */
  productNames: Record<string, string>;
  /** Two-letter codes; a customer abroad gets the reverse-charge note. */
  customerCountryCode: string | null;
  teamCountryCode: string | null;
  /** The team's own labels, `quote_settings.labels`. */
  labels?: Record<string, Record<string, string>> | null;
  logoUrl?: string | null;
  paymentDetails?: unknown;
  /**
   * The label of the general terms this version went out with (FF-1616),
   * e.g. `2026-01`. Null before any were uploaded, and the note is then
   * left off rather than referring to terms that do not exist.
   */
  termsLabel?: string | null;
  /**
   * The terms themselves, when the version was written in Midday rather than
   * uploaded (FF-1674). Printed as the quote's closing annex, so the client
   * holds them instead of being sent a second file. Null for a version that
   * is a file: those keep being named in the notes and nothing else.
   */
  termsContent?: unknown;
  /**
   * The bytes behind each picture the text holds, by its stored path. What
   * is missing is left out of the PDF rather than failing it.
   */
  images?: Record<string, ImageSource>;
};

export type ScenarioRow =
  | { type: "section"; title: string }
  | { type: "note"; text: string }
  | {
      type: "item";
      title: string;
      description: string | null;
      quantity: string;
      rate: string;
      amount: string;
      /** Charged once on a recurring scenario. */
      oneOff: boolean;
    }
  | { type: "subtotal"; label: string; amount: string };

export type ScenarioView = {
  id: string;
  name: string;
  recommended: boolean;
  /** A recurring scenario's term, billing, renewal and notice. */
  conditions: string | null;
  /**
   * Column headings — all four, so the preview can set the same table the
   * PDF prints (FF-1675). Two of them used to live only in the PDF template,
   * and the preview drew empty spans in their place: the rate column stood
   * under nothing and the two headings that were there read as unplaced.
   */
  descriptionLabel: string;
  quantityLabel: string;
  rateLabel: string;
  amountLabel: string;
  rows: ScenarioRow[];
  /** Per product, when there is more than one. */
  products: { name: string; quantity: string; rate: string; amount: string }[];
  optional: {
    title: string;
    description: string | null;
    quantity: string;
    amount: string;
    oneOff: boolean;
  }[];
  totals: { label: string; value: string; strong: boolean }[];
  cappedNote: string | null;
  paymentSchedule: { label: string; percent: string; amount: string }[];
};

export type ComparisonView = {
  columns: { name: string; recommended: boolean }[];
  /**
   * `lead` marks the one figure the reader came for — the total, or what a
   * recurring quote comes to over its term. A surface may draw it larger
   * than the rest instead of as one more row (FF-1666).
   */
  rows: {
    label: string;
    values: string[];
    lead?: boolean;
    /**
     * The label names the unit of the value — "Uren", "106 – 153" — so a
     * surface that has no room for a column of labels can write the two
     * together and still be read (FF-1666).
     */
    unit?: boolean;
  }[];
};

export type DocumentBlock =
  | { type: "text"; id: string; heading: string | null; body: EditorDoc }
  /** Where the list of sections is drawn (FF-1668). */
  | { type: "contents"; id: string }
  | {
      type: "pricing";
      id: string;
      comparison: ComparisonView | null;
      scenarios: ScenarioView[];
    };

export type QuoteDocument = {
  labels: QuoteLabels;
  images: Record<string, ImageSource>;
  logoUrl: string | null;
  fromDetails: EditorDoc | null;
  customerDetails: EditorDoc | null;
  paymentDetails: EditorDoc | null;
  title: string;
  /** The number with its version, e.g. `OFF-0001 v2`. */
  number: string;
  meta: { label: string; value: string }[];
  /** The mode statement. */
  statement: string;
  blocks: DocumentBlock[];
  notes: string[];
  /**
   * The general terms, set as the last pages of the document (FF-1674).
   * Null when the version on file is an uploaded PDF, or when none is
   * recorded at all — an empty heading over nothing is worse than no annex.
   */
  terms: { heading: string; body: EditorDoc } | null;
};

const LOCALES: Record<QuoteLanguage, string> = { nl: "nl-BE", en: "en-GB" };

/** Where a team with no country set sends from. */
const HOME_COUNTRY = "BE";

/**
 * An address as one block (FF-1679).
 *
 * The From and To blocks arrive as one paragraph per line — the customer
 * snapshot writes them that way, and so did the business identity until
 * FF-1677. The renderer already treats an address as a list of lines and
 * gives its paragraphs no room above, but each paragraph is still its own
 * box, and the boxes come to 23.1pt a line where one paragraph broken by
 * `hardBreak` comes to 17. So a block that is nothing but single-line
 * paragraphs is folded into one paragraph here, at the seam every version
 * old or new passes through — a block already stored on a sent version is
 * set as tightly as one made today.
 *
 * Only that shape is touched. A heading, a list, a paragraph that already
 * runs to more than one line: that is a document, and stays one.
 */
function asAddress(doc: EditorDoc | null): EditorDoc | null {
  if (!doc?.content?.length) return doc;
  // The schema keeps a node loose (`Record<string, unknown>`); its children
  // are editor nodes when there are any, which is the one thing read here.
  const children = (node: Record<string, unknown>): EditorNode[] =>
    Array.isArray(node.content) ? (node.content as EditorNode[]) : [];
  const lines: EditorNode[][] = [];
  for (const node of doc.content) {
    if (node.type !== "paragraph") return doc;
    const inline = children(node);
    if (inline.some((n) => n.type !== "text")) return doc;
    if (inline.length === 0) continue; // an empty paragraph is a blank line nobody meant
    lines.push(inline);
  }
  if (lines.length < 2) return doc;
  return {
    ...doc,
    content: [
      {
        type: "paragraph",
        content: lines.flatMap((inline, i) =>
          i === 0 ? inline : [{ type: "hardBreak" }, ...inline],
        ),
      },
    ],
  };
}

function asDoc(value: unknown): EditorDoc | null {
  const doc = value as EditorDoc | null | undefined;
  return doc?.type === "doc" && Array.isArray(doc.content) ? doc : null;
}

/**
 * The same, but a document with nothing in it is nothing (FF-1674). A terms
 * version created and never written into would otherwise open a page and
 * head it "Algemene voorwaarden" over an empty sheet.
 */
function asWrittenDoc(value: unknown): EditorDoc | null {
  const doc = asDoc(value);
  return doc && doc.content.length > 0 ? doc : null;
}

/** What the pricing of a version says, apart from the rest of the document. */
export type PricingViewInput = {
  content: QuoteContent;
  pricing: PricingResult;
  kind: QuoteKind;
  language: QuoteLanguage;
  currency: string;
  /** Product names by id; a line names its product. */
  productNames: Record<string, string>;
  /** The team's own labels, `quote_settings.labels`. */
  labels?: Record<string, Record<string, string>> | null;
};

type ViewContext = {
  labels: QuoteLabels;
  locale: string;
  format: Format;
  unitLabel: string;
  date: (value: string) => string;
  number: (value: number) => string;
  cents: (value: number) => string;
};

/** Every number and date in one language, the version's own. */
function viewContext(input: {
  language: QuoteLanguage;
  currency: string;
  content: QuoteContent;
  labels?: Record<string, Record<string, string>> | null;
}): ViewContext {
  const labels = quoteLabels(input.language, input.labels);
  const locale = LOCALES[input.language];
  const unit = input.content;

  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const currency = (value: number, decimals: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: input.currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: 2,
    }).format(value / 100);
  /**
   * A whole amount is written without its cents (FF-1675). Two decimals on
   * every figure cost six characters apiece, twice over in a range, which is
   * what pushed `€ 1.360,00 – € 2.040,00` past its column and broke it after
   * the dash. An amount that has cents still shows them.
   */
  const cents = (value: number) => currency(value, value % 100 === 0 ? 0 : 2);
  const range = (value: Amount, format: (n: number) => string) =>
    value.max === null || value.max === value.amount
      ? format(value.amount)
      : `${format(value.amount)} – ${format(value.max)}`;

  const format: Format = {
    money: (value: Amount) => range(value, cents),
    quantity: (hours: Amount) => range(amountInUnit(hours, unit), number),
    rate: (hourlyCents: number | null | undefined) =>
      hourlyCents === null || hourlyCents === undefined
        ? "–"
        : `${currency(rateInUnit(hourlyCents, unit), 2)}${
            unit.displayUnit === "days" ? labels.perDay : labels.perHour
          }`,
    percent: (value: number) => `${number(value)}%`,
  };

  return {
    labels,
    locale,
    format,
    unitLabel: unit.displayUnit === "days" ? labels.days : labels.hours,
    date,
    number,
    cents,
  };
}

/**
 * The comparison table and the scenarios, as they print. Split out of
 * `quoteDocument` (FF-1640) so the editor can draw the same thing on screen
 * without reaching for react-pdf: what the pricing *says* is worked out once,
 * here, and laid out twice.
 */
export function pricingView(input: PricingViewInput): {
  comparison: ComparisonView | null;
  scenarios: ScenarioView[];
} {
  const ctx = viewContext(input);
  const pricedById = new Map(
    input.pricing.scenarios.map((p) => [p.scenarioId, p]),
  );
  const scenarios = input.content.scenarios.flatMap((scenario) => {
    const priced = pricedById.get(scenario.id);
    return priced ? [{ scenario, priced }] : [];
  });

  return {
    scenarios: scenarios.map(({ scenario, priced }) =>
      scenarioView(scenario, priced, {
        labels: ctx.labels,
        format: ctx.format,
        unitLabel: ctx.unitLabel,
        productNames: input.productNames,
      }),
    ),
    comparison:
      scenarios.length > 1
        ? comparisonView(input.content, input.pricing, scenarios, {
            labels: ctx.labels,
            format: ctx.format,
            unitLabel: ctx.unitLabel,
            recurring: input.kind === "recurring",
          })
        : null,
  };
}

export function quoteDocument(input: QuotePdfInput): QuoteDocument {
  const { labels, date } = viewContext(input);
  const { comparison, scenarios: views } = pricingView(input);

  const blocks: DocumentBlock[] = input.content.blocks.flatMap((block) => {
    switch (block.type) {
      case "text":
        // A block with no heading and nothing written in it prints nothing
        // — but it is not nothing: its own room above it, plus the height
        // react-pdf gives an empty document, is enough to open a page and
        // then put no ink on it. That is the blank sheet OFF-0004 ended on.
        //
        // The editor keeps a trailing empty block to type into, which is
        // right on screen and has no business in the printed document.
        if (!block.heading?.trim() && block.body.content.length === 0) {
          return [];
        }
        return {
          type: "text",
          id: block.id,
          heading: block.heading,
          body: block.body,
        };
      case "contents":
        return { type: "contents", id: block.id };
      case "pricing":
        return { type: "pricing", id: block.id, comparison, scenarios: views };
      default:
        // A kind this build does not know, saved by a newer one. Printing
        // nothing is wrong; printing it as the pricing, which is what a
        // `default` arm would have done, is worse (FF-1668).
        return [];
    }
  });

  const teamCountry = (input.teamCountryCode || HOME_COUNTRY).toUpperCase();
  const customerCountry = input.customerCountryCode?.toUpperCase();
  const abroad = Boolean(customerCountry) && customerCountry !== teamCountry;
  const termsBody = asWrittenDoc(input.termsContent);

  return {
    labels,
    logoUrl: input.logoUrl ?? null,
    images: input.images ?? {},
    fromDetails: asAddress(asDoc(input.fromDetails)),
    customerDetails: asAddress(asDoc(input.customerDetails)),
    paymentDetails: asAddress(asDoc(input.paymentDetails)),
    title: input.title,
    number: formatQuoteVersion(input.quoteNumber, input.version),
    meta: [
      { label: labels.issueDate, value: date(input.issueDate) },
      { label: labels.validUntil, value: date(input.validUntil) },
    ],
    statement:
      input.mode === "firm"
        ? fill(labels.firm, { validUntil: date(input.validUntil) })
        : labels.estimate,
    blocks,
    notes: [
      labels.exclVat,
      ...(abroad ? [labels.reverseCharge] : []),
      ...(input.termsLabel
        ? [fill(labels.terms, { version: input.termsLabel })]
        : []),
    ],
    terms: termsBody ? { heading: labels.termsHeading, body: termsBody } : null,
  };
}

type Format = {
  money: (value: Amount) => string;
  quantity: (hours: Amount) => string;
  rate: (hourlyCents: number | null | undefined) => string;
  percent: (value: number) => string;
};

const PERIOD_LABELS: Record<Recurrence["period"], keyof QuoteLabels> = {
  month: "perMonth",
  quarter: "perQuarter",
  year: "perYear",
};

function conditions(recurrence: Recurrence, labels: QuoteLabels) {
  const parts = [
    recurrence.termMonths === null
      ? labels.indefinite
      : fill(labels.term, { months: recurrence.termMonths }),
    recurrence.billing === "in_advance" ? labels.inAdvance : labels.inArrears,
  ];
  if (recurrence.autoRenew) parts.push(labels.autoRenew);
  if (recurrence.noticeMonths) {
    parts.push(fill(labels.notice, { months: recurrence.noticeMonths }));
  }
  return `${parts.join(", ")}.`;
}

const nonZero = (value: Amount) => value.amount > 0 || (value.max ?? 0) > 0;

function sectionsWithItems(scenario: Scenario) {
  let count = 0;
  let open = false;
  for (const line of scenario.lines) {
    if (line.type === "section") {
      if (open) count++;
      open = false;
    } else if (line.type === "item" && !line.optional) {
      open = true;
    }
  }
  return open ? count + 1 : count;
}

/**
 * A scenario's rows in three runs for the page: up to its first line, which
 * stays with the heading; from its last line on, which stays with the
 * totals; and what lies between, free to break. With one line, all of it
 * stays together.
 */
export function scenarioParts(rows: ScenarioRow[]) {
  const first = rows.findIndex((r) => r.type === "item");
  let last = -1;
  rows.forEach((r, index) => {
    if (r.type === "item") last = index;
  });
  if (first === -1 || first === last) {
    return { head: rows, middle: [], tail: [], together: true };
  }
  return {
    head: rows.slice(0, first + 1),
    middle: rows.slice(first + 1, last),
    tail: rows.slice(last),
    together: false,
  };
}

function scenarioView(
  scenario: Scenario,
  priced: ScenarioPricing,
  ctx: {
    labels: QuoteLabels;
    format: Format;
    unitLabel: string;
    productNames: Record<string, string>;
  },
): ScenarioView {
  const { labels, format } = ctx;
  const recurrence = scenario.recurrence;
  const pricedLines = new Map(priced.lines.map((l) => [l.lineId, l]));
  const items = new Map(
    scenario.lines.flatMap((l) => (l.type === "item" ? [[l.id, l]] : [])),
  ) as Map<string, ItemLine>;

  // Subtotals only say something when more than one section has lines to
  // add up; a section that is empty, or only optional, does not count.
  const sections = new Map(priced.sections.map((s) => [s.lineId, s]));
  const showSubtotals = sectionsWithItems(scenario) > 1;

  const rows: ScenarioRow[] = [];
  let open = sections.get(null);
  let itemsInOpen = 0;
  const close = () => {
    if (!showSubtotals || !open || itemsInOpen === 0) return;
    rows.push({
      type: "subtotal",
      label: labels.subtotal,
      amount: format.money(open.amount),
    });
    if (nonZero(open.oneOff)) {
      rows.push({
        type: "subtotal",
        label: `${labels.subtotal}, ${labels.oneOff.toLowerCase()}`,
        amount: format.money(open.oneOff),
      });
    }
  };

  for (const line of scenario.lines) {
    if (line.type === "section") {
      close();
      rows.push({ type: "section", title: line.title });
      open = sections.get(line.id);
      itemsInOpen = 0;
    } else if (line.type === "note") {
      rows.push({ type: "note", text: line.text });
    } else if (!line.optional) {
      const p = pricedLines.get(line.id);
      rows.push({
        type: "item",
        title: line.title,
        description: line.description,
        quantity: format.quantity({
          amount: p?.hours ?? line.hours,
          max: p?.hoursMax ?? null,
        }),
        rate: format.rate(p?.rate),
        amount: p ? format.money({ amount: p.amount, max: p.amountMax }) : "–",
        oneOff: p?.once ?? false,
      });
      itemsInOpen++;
    }
  }
  close();

  const name = (productId: string) => ctx.productNames[productId] ?? "";
  const rate = (productId: string) =>
    format.rate(priced.rates[productId]?.rate);
  const products =
    priced.products.length > 1
      ? priced.products.flatMap((p) => {
          const out: ScenarioView["products"] = [];
          if (nonZero(p.hours)) {
            out.push({
              name: name(p.productId),
              quantity: format.quantity(p.hours),
              rate: rate(p.productId),
              amount: format.money(p.amount),
            });
          }
          if (nonZero(p.oneOffHours)) {
            out.push({
              name: `${name(p.productId)}, ${labels.oneOff.toLowerCase()}`,
              quantity: format.quantity(p.oneOffHours),
              rate: rate(p.productId),
              amount: format.money(p.oneOff),
            });
          }
          return out;
        })
      : [];

  const optional = priced.optional.map((p) => {
    const line = items.get(p.lineId);
    return {
      title: line?.title ?? "",
      description: line?.description ?? null,
      quantity: format.quantity({ amount: p.hours, max: p.hoursMax }),
      amount: `+${format.money({ amount: p.amount, max: p.amountMax })}`,
      oneOff: p.once,
    };
  });

  const totals: ScenarioView["totals"] = [];
  const t = priced.totals;
  if (t.kind === "project") {
    totals.push({
      label: labels.total,
      value: format.money(t.total),
      strong: true,
    });
  } else {
    if (recurrence && recurrence.period !== "year") {
      totals.push({
        label: labels[PERIOD_LABELS[recurrence.period]],
        value: format.money(t.perPeriod),
        strong: false,
      });
    }
    totals.push({
      label: labels.perYear,
      value: format.money(t.perYear),
      strong: t.overTerm === null,
    });
    if (t.overTerm) {
      totals.push({
        label: labels.overTerm,
        value: format.money(t.overTerm),
        strong: true,
      });
    }
    if (nonZero(t.oneOff)) {
      totals.push({
        label: labels.oneOff,
        value: format.money(t.oneOff),
        strong: false,
      });
    }
  }

  const hasMax =
    t.kind === "project" ? t.total.max !== null : t.perYear.max !== null;

  return {
    id: scenario.id,
    name: scenario.name,
    recommended: scenario.recommended,
    conditions: recurrence ? conditions(recurrence, labels) : null,
    descriptionLabel: labels.description,
    quantityLabel: ctx.unitLabel,
    rateLabel: labels.rate,
    amountLabel: recurrence
      ? labels[PERIOD_LABELS[recurrence.period]]
      : labels.amount,
    rows,
    products,
    optional,
    totals,
    cappedNote: t.capped && hasMax ? labels.capped : null,
    paymentSchedule: priced.paymentSchedule.map((p) => ({
      label: p.label,
      percent: format.percent(p.percent),
      amount: format.money({ amount: p.amount, max: null }),
    })),
  };
}

function comparisonView(
  content: QuoteContent,
  pricing: PricingResult,
  scenarios: { scenario: Scenario; priced: ScenarioPricing }[],
  ctx: {
    labels: QuoteLabels;
    format: Format;
    unitLabel: string;
    recurring: boolean;
  },
): ComparisonView {
  const { labels, format } = ctx;
  const compared = new Map(
    compareScenarios(content, pricing).map((c) => [c.scenarioId, c]),
  );
  const each = (cell: (s: (typeof scenarios)[number]) => string) =>
    scenarios.map(cell);

  const rows: ComparisonView["rows"] = [
    {
      label: labels.pricing,
      values: each(({ scenario }) =>
        scenario.pricing === "fixed"
          ? labels.fixed
          : scenario.capped
            ? labels.rangeCapped
            : labels.range,
      ),
    },
    {
      unit: true,
      label: ctx.recurring
        ? `${ctx.unitLabel} ${labels.perYear.toLowerCase()}`
        : ctx.unitLabel,
      values: each(({ scenario }) => {
        const c = compared.get(scenario.id);
        return c ? format.quantity(c.hours) : "–";
      }),
    },
  ];

  if (ctx.recurring) {
    rows.push({
      // Always populated on a recurring quote, where `overTerm` is a dash
      // unless the quote has a term.
      lead: true,
      label: labels.perYear,
      values: each(({ priced }) =>
        priced.totals.kind === "recurring"
          ? format.money(priced.totals.perYear)
          : "–",
      ),
    });
    rows.push({
      label: labels.overTerm,
      values: each(({ priced }) =>
        priced.totals.kind === "recurring" && priced.totals.overTerm
          ? format.money(priced.totals.overTerm)
          : "–",
      ),
    });
    // What is charged once is never added to what recurs, so it has a row.
    if (
      scenarios.some(
        ({ priced }) =>
          priced.totals.kind === "recurring" && nonZero(priced.totals.oneOff),
      )
    ) {
      rows.push({
        label: labels.oneOff,
        values: each(({ priced }) =>
          priced.totals.kind === "recurring" && nonZero(priced.totals.oneOff)
            ? format.money(priced.totals.oneOff)
            : "–",
        ),
      });
    }
  } else {
    rows.push({
      lead: true,
      label: labels.total,
      values: each(({ priced }) =>
        priced.totals.kind === "project"
          ? format.money(priced.totals.total)
          : "–",
      ),
    });
  }

  return {
    columns: scenarios.map(({ scenario }) => ({
      name: scenario.name,
      recommended: scenario.recommended,
    })),
    rows,
  };
}
