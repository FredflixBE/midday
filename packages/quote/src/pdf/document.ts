import type { ImageSource } from "@midday/invoice/templates/pdf/format";
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
  /** Column headings. */
  quantityLabel: string;
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
  rows: { label: string; values: string[] }[];
};

export type DocumentBlock =
  | { type: "text"; id: string; heading: string | null; body: EditorDoc }
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
};

const LOCALES: Record<QuoteLanguage, string> = { nl: "nl-BE", en: "en-GB" };

/** Where a team with no country set sends from. */
const HOME_COUNTRY = "BE";

function asDoc(value: unknown): EditorDoc | null {
  const doc = value as EditorDoc | null | undefined;
  return doc?.type === "doc" && Array.isArray(doc.content) ? doc : null;
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
  const cents = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: input.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 100);
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
        : `${cents(rateInUnit(hourlyCents, unit))}${
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

  const blocks: DocumentBlock[] = input.content.blocks.map((block) =>
    block.type === "text"
      ? {
          type: "text",
          id: block.id,
          heading: block.heading,
          body: block.body,
        }
      : { type: "pricing", id: block.id, comparison, scenarios: views },
  );

  const teamCountry = (input.teamCountryCode || HOME_COUNTRY).toUpperCase();
  const customerCountry = input.customerCountryCode?.toUpperCase();
  const abroad = Boolean(customerCountry) && customerCountry !== teamCountry;

  return {
    labels,
    logoUrl: input.logoUrl ?? null,
    images: input.images ?? {},
    fromDetails: asDoc(input.fromDetails),
    customerDetails: asDoc(input.customerDetails),
    paymentDetails: asDoc(input.paymentDetails),
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
    quantityLabel: ctx.unitLabel,
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
