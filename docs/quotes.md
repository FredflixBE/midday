# Quotes — design

Status: draft for discussion, 2026-09-19. Nothing here is built yet.

Business input: RES-24 (requirements R1–R13, use cases A–E) and RES-23 (evidence). This document turns those into a data model, pricing rules and a build order. Items marked **Open** still need a decision.

## 1. What a quote is here

A quote is a proposal text plus one or more priced scenarios, sent as a PDF. Every price is hours × a rate. The client picks one scenario.

| Term | Meaning |
|---|---|
| Quote | The parent. One customer, one subject, one number. Everything is followed up here. |
| Version | One revision of the quote. What gets sent. Holds the mode, validity, text, scenarios. |
| Scenario | A complete priced variant inside a version. The client accepts exactly one. |
| Line | A row in a scenario: a section heading, a note, or a priced item. |
| Product | One of Midday's products (the same list invoices use; first-line maintenance, development, …). On a quote its price is the hourly rate (FF-1620). |
| Adjustment | A percentage on the rate, driven by volume of hours and/or contract term. |
| Optional line | A priced item shown with its price but outside the scenario total. The client may take it or leave it. |
| Mode | `estimate` (not binding, an invitation to negotiate) or `firm` (binding offer until the validity date). |

Why scenarios sit under a version: what gets accepted must be one identifiable thing (Civil Code art. 5.20), and that is one version plus one scenario. Changing the mode, the rates or the text makes a new version; the scenarios come along.

## 2. Reuse, not new dependencies

| Need | Reused |
|---|---|
| PDF | `@react-pdf/renderer` and the invoice PDF building blocks in `packages/invoice/src/templates/pdf` (fonts, logo, layout, `formatEditorContent`) |
| Rich text | Tiptap editor from `packages/ui` (already used for the invoice top and bottom blocks) |
| Reordering | `@dnd-kit` |
| Customer and sender snapshot | Same `EditorDoc` shape as `invoices.customerDetails` / `fromDetails` |
| Numbering | Same approach as `getNextInvoiceNumber` (`packages/db/src/queries/invoices.ts`), own prefix |
| Stored files (phase 2) | Supabase storage, the `vault` bucket |
| Assistant access (phase 2) | New tools next to `apps/api/src/mcp/tools/invoices.ts` |

One change to shared code: `formatEditorContent` only renders paragraphs with bold, italic, strike and links. Quotes need headings and bullet/numbered lists. The converter gets extended in place, so invoices benefit too.

New package `packages/quote` (mirrors `packages/invoice`): the zod schema for the version content, the pricing module, and the PDF template. It imports the shared PDF pieces from `@midday/invoice`.

## 3. Data model

Three new tables (quotes, versions, settings) plus one per-customer rate table on top of Midday's products. All carry `team_id` with the usual team RLS policy.

### 3.1 Rates

```
invoice_products                  -- Midday's own products; on a quote, price = hourly rate
  id, team_id, name, price numeric(10,2), currency, unit, is_active

customer_product_rates
  customer_id → customers, product_id → invoice_products, team_id,
  hourly_rate numeric(10,2)
  primary key (customer_id, product_id)
```

Rates are stored per hour. Day rates are displayed as hours per day × the hourly rate (see 3.4).

### 3.2 Quotes and versions

```
quotes
  id, team_id, customer_id → customers,
  quote_number text            -- e.g. OFF-0001, own sequence
  title text
  kind  quote_kind             -- 'project' | 'recurring'
  language text                -- 'nl' | 'en'
  currency text
  outcome quote_outcome        -- 'open' | 'won' | 'lost' | 'no_decision'
  outcome_reason text null
  outcome_at timestamptz null
  tracker_project_id → tracker_projects null   -- phase 2
  created_by, created_at, updated_at

quote_versions
  id, team_id, quote_id → quotes,
  version int                  -- 1, 2, 3 …
  status quote_version_status  -- 'draft' | 'sent' | 'superseded' | 'accepted'
  mode   quote_mode            -- 'estimate' | 'firm'
  issue_date date, valid_until date,
  sent_at timestamptz null, sent_to text null,
  customer_details jsonb, from_details jsonb,   -- snapshots, as on invoices
  content jsonb                -- blocks, rate settings, scenarios (3.3)
  pricing jsonb null           -- frozen pricing result, written when sent (4.6)
  internal_note text null
  -- phase 2, acceptance
  accepted_scenario_id text null, accepted_optional_line_ids text[] null,
  accepted_at timestamptz null, accepted_by_name text null,
  po_number text null, acceptance_file_path text[] null,
  terms_version_id → quote_terms null, pdf_path text[] null
  unique (quote_id, version)
```

Rules:
- Only a `draft` version can be edited. Once marked sent it is frozen, because the client holds that PDF.
- **Revise** copies the latest version into a new `draft` (version + 1). When the new one is marked sent, the previous sent version becomes `superseded`.
- A quote has at most one `draft` version at a time.
- **Expired** is computed, never stored: `status = 'sent' and valid_until < today`.
- Accepting a version (phase 2) sets it `accepted` and the quote's outcome to `won`. Lost and no-decision are set by hand with a reason.

### 3.3 Version content (jsonb)

Scenarios and lines live as jsonb inside the version, not in their own tables. They are always edited, copied and frozen together with their version, which is also how invoices keep `lineItems`. The shape is enforced by a zod schema in `packages/quote`.

```ts
type QuoteContent = {
  blocks: Block[];                       // the proposal text, in order
  rates: {
    productRates: Record<ProductId, number>;   // quote-level overrides
    volumeTiers: { minHours: number; percent: number }[];  // e.g. {100, -5}
    termTiers:   { minMonths: number; percent: number }[]; // e.g. {24, -5}
  };
  displayUnit: "hours" | "days";
  hoursPerDay: number;                   // default 8
  scenarios: Scenario[];
};

type Block =
  | { id: string; type: "text"; heading: string | null; body: EditorDoc }
  | { id: string; type: "pricing" };     // where the scenarios appear

type Scenario = {
  id: string;
  name: string;                          // "8 days a year", "Fixed price"
  recommended: boolean;
  pricing: "fixed" | "range";
  capped: boolean;                       // range only: max is a ceiling
  recurrence: null | {                   // required when quote.kind = recurring
    period: "month" | "quarter" | "year";
    termMonths: number | null;           // null = indefinite
    billing: "in_advance" | "in_arrears";
    autoRenew: boolean;
    noticeMonths: number | null;
  };
  adjustmentOverride: number | null;     // percent; replaces the tiers
  paymentSchedule: { label: string; percent: number }[];  // project quotes
  lines: Line[];
};

type Line =
  | { id: string; type: "section"; title: string }
  | { id: string; type: "note"; text: string }
  | {
      id: string; type: "item";
      title: string; description: string | null;
      productId: string;
      hours: number;                     // fixed: the hours; range: the minimum
      hoursMax: number | null;           // range only
      optional: boolean;
      once: boolean;                     // recurring quotes: one-off, not per period
    };
```

Starting content comes from team settings (3.4). There is no reusable content library in v1.

### 3.4 Team settings

One row per team (or columns on an existing settings table; decided when building):

```
quote_settings
  team_id, number_prefix text default 'OFF-',
  default_valid_days int default 30, hours_per_day numeric default 8,
  default_blocks jsonb           -- copied into every new quote,
                                 -- e.g. the no-lock-in licence block (R12)
  labels jsonb                   -- PDF labels per language: { nl: {...}, en: {...} }
```

Phase 2 adds `quote_terms` (id, team_id, version label, file path, created_at). A version records the terms it was sent with.

## 4. Pricing rules

Pricing is one pure function in `packages/quote`, `priceVersion(content, rates) → PricingResult`, used by the editor, the PDF and the MCP tools. It works in cents internally and is fully unit-tested against use cases A–E.

### 4.1 The hourly rate of a line

```
base  = content.rates.productRates[p]         -- quote override
     ?? customer_product_rates[customer][p]    -- customer override
     ?? invoice_products[p].price              -- default
rate  = round(base × (1 + adjustment / 100))   -- see Open 3
```

### 4.2 The adjustment of a scenario

```
adjustment = scenario.adjustmentOverride
          ?? (best volume tier met by committed hours)
           + (best term tier met by termMonths)
```

- A quote can have only volume tiers, only term tiers, both, or neither (R7).
- Volume and term add up: −5% and −5% make −10%. That's easier to explain on a PDF than a compound.
- **Committed hours** (Open 1): per year for recurring scenarios, the total for fixed project scenarios, the minimum for range scenarios.
- The PDF shows the adjusted rate. Whether it also shows the discount is Open 4.

### 4.3 Amounts

- Item: `hours × rate`; for range also `hoursMax × rate`.
- Section subtotal: sum of the items under it until the next section.
- **Product subtotal**: sum per product across the scenario (use case A asks for days split by type of work).
- Optional items are priced but left out of every total. They are listed separately as "Optional: …, +€x".

### 4.4 Project scenarios

- **Fixed**: total = Σ items.
- **Range**: min total and max total. If `capped`, the max is a ceiling and the PDF says so.
- Payment schedule rows are percentages of the (max) total and must add up to 100%.

### 4.5 Recurring scenarios

- Per period = Σ recurring items (hours are per period).
- Per year = per period × periods per year.
- Over the term = per year × termMonths / 12.
- One-off items (`once`) are shown separately.
- **Contract value** = over the term + one-off items. For an indefinite term, contract value uses 48 months. That's the value Belgian procurement counts (RES-24 8.8); it's shown on the internal panel and not printed unless asked.

### 4.6 Freezing

Marking a version sent writes the full `PricingResult` (resolved rates, all totals) into `quote_versions.pricing`. A sent version is always rendered from that snapshot, so a later change to a default or customer rate never changes a quote the client already has.

### 4.7 Internal comparison panel

The editor shows all scenarios of the version side by side: total (or min–max), adjustment, hours, and contract value. When the version has both fixed and range scenarios, it also shows each fixed price's premium over the midpoint and over the max of each range. That makes the price of carrying the risk visible (RES-24 §3) while building. It never appears on the PDF.

## 5. Screens

- **Quotes** page in the sidebar, next to Invoices. The list shows number, customer, title, latest version and status, mode, total, sent date and valid-until, with filters: draft, awaiting answer, expiring within 7 days, expired, won, lost.
- **Quote editor** as a full page (a quote is too big for the invoice sheet):
  - header: customer, title, kind, mode, language, validity
  - the text blocks, reorderable, with the pricing block among them
  - scenarios as tabs; each tab has a line table (drag to reorder; product picker; hours or min–max; optional toggle; one-off toggle for recurring) plus the recurrence and payment settings
  - rate settings for the quote: overrides and tiers
  - the internal comparison panel
  - actions: Duplicate scenario, Download PDF, Mark as sent, Revise, Set outcome
- **Products**: its own page in the sidebar; a product's price is its default hourly rate on quotes.
- **Settings → Quotes**: number prefix, default validity, default blocks, labels.
- **Customer details**: rate overrides per product.

Following the rule that screens stay minimal: no helper text or provenance labels under fields.

"Regenerate under a different scenario" (R4) is **Duplicate scenario**, then change the term, pricing mode or hours. Every total recomputes live. No separate generator is needed.

## 6. PDF

A new react-pdf template in `packages/quote`, downloaded from the dashboard. It's served the way the invoice download is (`apps/api/src/rest/routers/files/download.ts`). In order:

1. Header with the logo, the sender's legal details (name, legal form, registered office, enterprise number, RPR and court: WVV art. 2:20; one bank account: WER art. III.25), quote number and version, issue date, and the customer.
2. A mode statement. Estimate: "Indicative estimate, not a binding offer." Firm: "This offer is binding until {valid_until}."
3. The text blocks in order. At the pricing block:
   - a comparison table when there are several scenarios (one column per scenario, recommended one marked)
   - then each scenario: lines grouped by section, section subtotals, work-type subtotals, optional items, totals (per period, per year, over the term for recurring; fixed, or min–max with the cap, for project), payment schedule.
4. Amounts are excluding VAT (Open 5).

**The PDF of a sent version is stored** (FF-1615). A version freezes its
content, its pricing and the sender and customer snapshots, but the logo, the
payment details, the team's labels and the pictures in the text are all read
live when the quote is drawn — so only a file can be what the client holds.
Marking a version sent renders it once and keeps it in the `vault` bucket
under `<team>/quotes/<version id>.pdf`, inside the same transaction: a PDF
that cannot be stored refuses the send. The download serves that file when
there is one, and draws the quote only for a draft (or a version sent before
this was built).

## 7. Build order

**Phase 1: send a multi-scenario estimate as a PDF (the first real use case).**

1. Rates from products, with customer overrides (first built as a separate list of work types, FF-1607; moved onto Midday's products by FF-1620).
2. Quote schema, version rules (draft, sent, superseded, revise), numbering, zod content schema, `quote_settings`.
3. Pricing module with unit tests for use cases A–E.
4. Quote editor: header, blocks, scenarios, lines, rates, comparison panel.
5. PDF template and download. Extend `formatEditorContent` with headings and lists.
6. Quotes list with the follow-up filters; Mark as sent; Revise; manual outcome.

**Phase 2: acceptance and hand-over.**

7. Record acceptance by hand: chosen scenario, chosen optional items, name, date, PO number, attached order form. Store the PDF of the accepted version.
8. General terms versions and the snapshot at sending.
9. Convert an accepted quote into a tracker project.
10. MCP tools: list quotes, get quote, quotes awaiting an answer.

**Later:** public link and viewed timestamp, click-acceptance, sending by email, reminder emails, draft invoices from the payment schedule, reusable content library, linked quotes (use case C), estimated-versus-actual reporting.

## 8. Open decisions

1. **Committed hours for volume tiers.** Proposed: per year (recurring), total (fixed), minimum (range).
2. **Tiers add up** (−5% + −5% = −10%) rather than compound. Proposed: add up.
3. **Rounding of the adjusted rate.** A percentage rarely lands on a round number (€1,480 − 5% = €1,406 a day). Proposed: round the hourly rate to whole euros. When an exact figure matters, `adjustmentOverride` or a quote-level rate override sets it.
4. **Show the discount on the PDF** ("€185 − 5% = €176") or only the resulting rate? Proposed: only the rate.
5. **VAT.** Proposed: amounts excluding VAT with a statement to that effect, and a reverse-charge note for customers outside Belgium. No VAT calculation in v1.
6. **Number format.** Proposed: `OFF-0001`, versions shown as `OFF-0001 v2` from the second version on.
7. **Tracker conversion (phase 2).** A tracker project has one rate and an estimate in whole hours. Proposed: one project per accepted quote, rate = total ÷ hours (blended), estimate = hours rounded up (the max for range, per year for recurring). Comparing hours per product needs tracker entries tagged with a product. That comes later.
8. **Hours per day.** Proposed: 8, set per team, overridable per quote.
