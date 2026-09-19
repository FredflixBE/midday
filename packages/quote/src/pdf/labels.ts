/**
 * The words on a quote PDF, per language (FF-1613). A team overrides any of
 * them in `quote_settings.labels`, as `{ nl: { key: text }, en: { ... } }`;
 * a key it leaves out, or one this list does not know, falls back to these.
 * `{name}` is filled in where a label has one.
 */
export const QUOTE_LABELS = {
  en: {
    quote: "Quote",
    issueDate: "Date",
    validUntil: "Valid until",
    from: "From",
    to: "To",
    estimate: "Indicative estimate, not a binding offer.",
    firm: "This offer is binding until {validUntil}.",
    comparison: "Comparison",
    recommended: "Recommended",
    pricing: "Pricing",
    fixed: "Fixed price",
    range: "Range",
    rangeCapped: "Range with a ceiling",
    description: "Description",
    hours: "Hours",
    days: "Days",
    rate: "Rate",
    amount: "Amount",
    perHour: "/h",
    perDay: "/day",
    subtotal: "Subtotal",
    byProduct: "By type of work",
    optional: "Optional, not included in the total",
    oneOff: "One-off",
    total: "Total",
    capped: "The maximum is a ceiling and will not be exceeded.",
    perMonth: "Per month",
    perQuarter: "Per quarter",
    perYear: "Per year",
    overTerm: "Over the term",
    term: "Term of {months} months",
    indefinite: "Indefinite term",
    inAdvance: "billed in advance",
    inArrears: "billed in arrears",
    autoRenew: "renews automatically",
    notice: "{months} months' notice",
    paymentSchedule: "Payment schedule",
    paymentDetails: "Payment details",
    exclVat: "All amounts exclude VAT.",
    reverseCharge: "VAT reverse charge: the customer accounts for the VAT.",
    page: "Page {page} of {pages}",
  },
  nl: {
    quote: "Offerte",
    issueDate: "Datum",
    validUntil: "Geldig tot",
    from: "Van",
    to: "Aan",
    estimate: "Indicatieve raming, geen bindend aanbod.",
    firm: "Dit aanbod is bindend tot {validUntil}.",
    comparison: "Vergelijking",
    recommended: "Aanbevolen",
    pricing: "Prijszetting",
    fixed: "Vaste prijs",
    range: "Vork",
    rangeCapped: "Vork met plafond",
    description: "Omschrijving",
    hours: "Uren",
    days: "Dagen",
    rate: "Tarief",
    amount: "Bedrag",
    perHour: "/u",
    perDay: "/dag",
    subtotal: "Subtotaal",
    byProduct: "Per soort werk",
    optional: "Optioneel, niet in het totaal",
    oneOff: "Eenmalig",
    total: "Totaal",
    capped: "Het maximum is een plafond en wordt niet overschreden.",
    perMonth: "Per maand",
    perQuarter: "Per kwartaal",
    perYear: "Per jaar",
    overTerm: "Over de looptijd",
    term: "Looptijd van {months} maanden",
    indefinite: "Onbepaalde looptijd",
    inAdvance: "vooraf gefactureerd",
    inArrears: "achteraf gefactureerd",
    autoRenew: "stilzwijgend verlengd",
    notice: "opzegtermijn van {months} maanden",
    paymentSchedule: "Betalingsschema",
    paymentDetails: "Betaalgegevens",
    exclVat: "Alle bedragen zijn exclusief btw.",
    reverseCharge:
      "Btw verlegd: de medecontractant is tot voldoening van de btw gehouden.",
    page: "Pagina {page} van {pages}",
  },
} as const;

export type QuoteLanguage = keyof typeof QUOTE_LABELS;
export type QuoteLabelKey = keyof (typeof QUOTE_LABELS)["en"];
export type QuoteLabels = Record<QuoteLabelKey, string>;

/** The labels for a language, with the team's own over the defaults. */
export function quoteLabels(
  language: QuoteLanguage,
  overrides?: Record<string, Record<string, string>> | null,
): QuoteLabels {
  const own = overrides?.[language] ?? {};
  const labels = { ...QUOTE_LABELS[language] } as QuoteLabels;
  for (const key of Object.keys(labels) as QuoteLabelKey[]) {
    const text = own[key];
    if (typeof text === "string" && text.trim()) labels[key] = text;
  }
  return labels;
}

/** A label with its `{name}` placeholders filled in. */
export function fill(label: string, values: Record<string, string | number>) {
  return label.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
