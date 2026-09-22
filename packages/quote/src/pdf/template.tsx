import "@midday/invoice/templates/pdf/fonts";
import {
  formatEditorContent,
  type ImageSource,
} from "@midday/invoice/templates/pdf/format";
import {
  blockHeadingSize,
  documentTitleSize,
  headingSize,
  measureWidth,
  QUOTE_TYPESET,
  TYPESET,
} from "@midday/invoice/templates/typeset";
import type { EditorDoc as InvoiceEditorDoc } from "@midday/invoice/types";
import { Document, Image, Page, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";
import type { EditorDoc } from "../content";
import {
  type ComparisonView,
  type QuoteDocument,
  type ScenarioRow,
  type ScenarioView,
  scenarioParts,
} from "./document";
import { fill } from "./labels";

/**
 * The quote PDF (FF-1613, docs/quotes.md §6): lays out a `QuoteDocument`,
 * which has already decided every word and number on it. A scenario's last
 * line and its totals are kept on one page.
 */

/**
 * What a quote reads at in print (FF-1666).
 *
 * 11, not the invoice's 9. FF-1662 found a line running 120 characters and
 * narrowed the column to fix it, which was half the answer: the other half
 * is that 9pt is the size of a note at the foot of an invoice, not of a
 * document someone is asked to read and approve. Narrowing alone left three
 * of five pages as a thin column with an empty third beside it.
 *
 * At 11pt the same column of page holds about 68 characters instead of 120,
 * and the page is full. Everything else here is a multiple of it.
 */
const PRINT_BODY = 11;
/**
 * The general terms (FF-1674). Small print, as terms are set on the back of
 * every contract: they are there to be complete and consulted, not read
 * through, and at the document's own size they outrun the offer they belong
 * to.
 */
const PRINT_FINE = 6.5;
/**
 * Tighter than the tight scale's 1.55, because there is a lot of it and it
 * is set the width of the page. Measured on the real terms: at 7.5/1.55 they
 * run to three pages, at 6.5/1.35 to two, and going smaller still buys no
 * third page — so this is the smallest step that is worth taking.
 */
const FINE_LEADING = 1.35;
const COLUMN = measureWidth(PRINT_BODY);

const GREY = "#606060";
const RULE = "#DCDAD2";
/* The proportion it always had to the body: 8 against 9. */
const small: Style = { fontSize: PRINT_BODY * 0.89, color: GREY };
/**
 * A micro-label: uppercase, letterspaced, small and grey (FF-1666).
 *
 * The thing that reads as a technical document rather than a letter. It is
 * shadcn/typeset's own treatment for its smallest heading, and it is what
 * marks a word as a label rather than as something to read.
 */
const eyebrow: Style = {
  fontSize: PRINT_BODY * 0.68,
  color: GREY,
  textTransform: "uppercase",
  letterSpacing: 0.8,
};
const body: Style = { fontSize: PRINT_BODY };

/**
 * The page (FF-1666).
 *
 * Everything starts at the same left edge. Running text stops at the
 * measure; a section's rule and its pricing tables run to the right edge of
 * the page. That is the whole layout: one edge to read down, and the rule
 * holding the other side so a narrower column of prose reads as a measure
 * rather than as a page with a piece missing.
 *
 * The sidehead this replaced put titles in a column of their own, and the
 * boundary it drew was in the margin while the text beside it just kept
 * flowing — so a section began on the left and did not begin on the right.
 */

/**
 * Where a section starts (FF-1666).
 *
 * Its number and a rule to the edge of the page, and the title under them.
 * The rule is the part that matters: it is the only thing that says a
 * section has ended and another has begun, and it says it across the whole
 * width rather than only where the prose happens to reach.
 */
/**
 * The sections, listed once at the top (FF-1666).
 *
 * A quote is not read start to finish. It is read once, then flipped back
 * through while someone decides, and the numbers are how they say which
 * part they mean. This is eight lines that turn five pages into something
 * navigable.
 *
 * No page numbers against them: react-pdf lays out in one pass, so nothing
 * knows which page a section will land on until it is too late to print it.
 * The numbers are what a reader points at anyway.
 *
 * Left out below three sections, where a list of two is furniture.
 */
function Contents({
  doc,
  sections,
}: {
  doc: QuoteDocument;
  sections: Map<string, string>;
}) {
  const listed = doc.blocks.filter(
    (block) => block.type === "text" && block.heading,
  );
  if (listed.length < 3) {
    return null;
  }

  return (
    // Whole while it is short enough that moving it leaves a small hole.
    // A quote with many sections gets a list that may break instead.
    <View wrap={listed.length > 8} style={{ width: COLUMN, marginBottom: 24 }}>
      <Text style={{ ...small, marginBottom: 4 }}>{doc.labels.contents}</Text>
      {listed.map((block) => (
        <View
          key={block.id}
          style={{
            flexDirection: "row",
            paddingVertical: 3,
            borderTopWidth: 0.5,
            borderTopColor: RULE,
          }}
        >
          <Text style={{ ...small, width: 22 }}>{sections.get(block.id)}</Text>
          <Text style={body}>
            {block.type === "text" ? block.heading : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The general terms, set as the quote's closing annex (FF-1674).
 *
 * A `Page` of their own rather than a `View break`. Both start a new sheet,
 * but `break` on an element that would have begun a page anyway forces a
 * second one: on OFF-0004 that left page 7 empty but for its footer, with
 * the terms on page 8. A page is also what these are — the offer ends, and
 * this is what is appended after it. Running them on from the last line of
 * the offer would read as though the offer continued.
 *
 * The text goes through `Rich` in prose like every block, which is the whole
 * reason this is written rather than an uploaded PDF stapled to the back:
 * one document, one measure, one scale.
 */
/** Every page of the document is set the same (FF-1666). */
const PAGE = {
  paddingTop: 36,
  paddingBottom: 48,
  paddingHorizontal: 40,
  fontFamily: "Inter",
  fontWeight: 400,
  color: "#000",
  backgroundColor: "#fff",
} as const;

function TermsPage({
  terms,
  doc,
}: {
  terms: NonNullable<QuoteDocument["terms"]>;
  doc: QuoteDocument;
}) {
  return (
    <Page size="A4" wrap style={PAGE}>
      <SectionHead title={terms.heading} body={PRINT_FINE} />
      {/* No measure here, unlike every other block: running text takes a
          measure so it can be read across, and small print takes the page
          so there is less of it. */}
      <Rich doc={terms.body} fine />
      <Footer doc={doc} />
    </Page>
  );
}

/** The number and the page count, repeated at the foot of every page. */
function Footer({ doc }: { doc: QuoteDocument }) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        bottom: 20,
        left: 40,
        right: 40,
        flexDirection: "row",
        justifyContent: "space-between",
      }}
    >
      <Text style={small}>{doc.number}</Text>
      <Text
        style={small}
        render={({ pageNumber, totalPages }) =>
          fill(doc.labels.page, { page: pageNumber, pages: totalPages })
        }
      />
    </View>
  );
}

function SectionHead({
  number,
  title,
  body = PRINT_BODY,
}: {
  number?: string;
  title: string;
  /**
   * The size the title is scaled from. The annex of terms passes its own,
   * so its heading belongs to the small print under it rather than to the
   * offer — a section title at the quote's size over 6.5pt clauses is the
   * "this is still the quote" the annex is meant to avoid (FF-1674).
   */
  body?: number;
}) {
  return (
    // Never split, and never the last thing on a page: a rule at the foot
    // of one page with its title at the head of the next is worse than no
    // rule at all. `wrap` keeps the three lines together and
    // `minPresenceAhead` keeps them with the text they introduce.
    <View
      wrap={false}
      minPresenceAhead={PRINT_BODY * QUOTE_TYPESET.leading.body * 3}
      style={{ marginBottom: PRINT_BODY * QUOTE_TYPESET.flow.below }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginBottom: 5,
        }}
      >
        {number ? (
          <Text style={{ ...small, marginRight: 8 }}>{number}</Text>
        ) : null}
        <View style={{ flex: 1, borderTopWidth: 0.5, borderTopColor: RULE }} />
      </View>
      <Text
        style={{
          fontSize: blockHeadingSize(body),
          fontWeight: QUOTE_TYPESET.weight.blockHeading,
          lineHeight: QUOTE_TYPESET.leading.heading,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

/**
 * What each titled section is called by its number (FF-1666).
 *
 * A client answers a quote section by section — "over punt 3 heb ik een
 * vraag" needs a 3 to point at — which is the whole reason these are drawn.
 * So only a section a reader can name is counted: a block with no title is
 * a continuation of the one above it, and the pricing is reached by its own
 * tables rather than by number.
 */
function sectionNumbers(doc: QuoteDocument): Map<string, string> {
  const numbers = new Map<string, string>();
  let n = 0;
  for (const block of doc.blocks) {
    if (block.type === "text" && block.heading) {
      n += 1;
      numbers.set(block.id, String(n).padStart(2, "0"));
    }
  }
  return numbers;
}
const strong: Style = { fontSize: PRINT_BODY, fontWeight: 600 };

// Line columns: description, quantity, rate, amount.
/**
 * A priced table's fixed columns, as multiples of the body size (FF-1666).
 *
 * They were 64, 84 and 124pt, which fitted "€ 20.808,00" at 9pt and did not
 * at 11 — the rate ran straight into the amount. A column holding a number
 * has to be measured in the type it holds, not in points someone chose once.
 */
const QUANTITY_WIDTH = PRINT_BODY * 7;
const RATE_WIDTH = PRINT_BODY * 9.5;
const AMOUNT_WIDTH = PRINT_BODY * 14;

function Rich({
  doc,
  images,
  prose = false,
  fine = false,
}: {
  doc: EditorDoc | null;
  /** Given, the text's pictures are drawn from these bytes. */
  images?: Record<string, ImageSource>;
  /**
   * True where this is the document itself rather than one of the blocks of
   * detail around it (FF-1663). A quote's text is prose and is set in the
   * quote's own rhythm, which is shadcn/typeset's: loose lines, room between
   * paragraphs, headings that step.
   *
   * An address is a list of lines — "DPG Media NV", "Belgium", an email —
   * and at 1.75 it spreads down the page. It keeps the tighter rhythm every
   * other document in this codebase uses, which is exactly what it was
   * drawn at before there were two.
   */
  prose?: boolean;
  /**
   * True sets this as small print (FF-1674): the general terms, which are
   * twenty thousand characters of clauses nobody reads line by line. Set in
   * the quote's own 11pt prose they ran to eight pages and read as though
   * the offer were still going. They take the tight scale, a smaller body
   * and the full width of the page — which is what terms look like
   * everywhere, and what gets them into two pages.
   */
  fine?: boolean;
}) {
  if (!doc) return null;
  const scale = prose ? QUOTE_TYPESET : TYPESET;
  const size = fine ? PRINT_FINE : PRINT_BODY;
  if (fine) {
    return (
      <View style={{ fontSize: size, lineHeight: FINE_LEADING }}>
        {formatEditorContent(doc as unknown as InvoiceEditorDoc, {
          imageOf: (path) => images?.[path] ?? null,
          spacedParagraphs: true,
          scale,
          body: size,
          headingWeight: scale.weight.heading,
        })}
      </View>
    );
  }
  return (
    // Sized here: react-pdf's default of 18 would set the line height.
    // Bounded here too: the page is 515pt wide and a line of text is not
    // (FF-1662) — the tables below take the page, the prose takes a measure.
    <View
      style={{
        fontSize: PRINT_BODY,
        lineHeight: scale.leading.body,
        maxWidth: measureWidth(PRINT_BODY),
      }}
    >
      {/* The same Tiptap shape, typed loosely on this side. */}
      {formatEditorContent(doc as unknown as InvoiceEditorDoc, {
        imageOf: (path) => images?.[path] ?? null,
        // Both, as before: whether an address wants room under each of its
        // lines is a question this change does not open.
        spacedParagraphs: true,
        scale,
        body: PRINT_BODY,
        headingWeight: scale.weight.heading,
      })}
    </View>
  );
}

function Cells({
  cells,
  style,
}: {
  cells: [ReactNode, ReactNode, ReactNode, ReactNode];
  style?: Style;
}) {
  const [description, quantity, rate, amount] = cells;
  return (
    <View style={{ flexDirection: "row", paddingVertical: 3, ...style }}>
      <View style={{ flex: 1, paddingRight: 8 }}>{description}</View>
      <Text style={{ ...body, width: QUANTITY_WIDTH, textAlign: "right" }}>
        {quantity}
      </Text>
      <Text style={{ ...body, width: RATE_WIDTH, textAlign: "right" }}>
        {rate}
      </Text>
      <Text style={{ ...body, width: AMOUNT_WIDTH, textAlign: "right" }}>
        {amount}
      </Text>
    </View>
  );
}

function Row({ row, oneOff }: { row: ScenarioRow; oneOff: string }) {
  switch (row.type) {
    case "section":
      return (
        <View minPresenceAhead={40} style={{ marginTop: 8 }}>
          <Text style={strong}>{row.title}</Text>
        </View>
      );
    case "note":
      return (
        <Text style={{ ...small, fontStyle: "italic", paddingVertical: 2 }}>
          {row.text}
        </Text>
      );
    case "subtotal":
      return (
        <Cells
          cells={[
            <Text key="label" style={{ ...body, color: GREY }}>
              {row.label}
            </Text>,
            "",
            "",
            row.amount,
          ]}
          style={{ borderTopWidth: 0.5, borderTopColor: RULE }}
        />
      );
    default:
      return (
        <Cells
          cells={[
            <View key="description">
              <Text style={body}>{row.title}</Text>
              {row.description ? (
                <Text style={{ ...small, marginTop: 1 }}>
                  {row.description}
                </Text>
              ) : null}
              {row.oneOff ? (
                <Text style={{ ...small, marginTop: 1 }}>{oneOff}</Text>
              ) : null}
            </View>,
            row.quantity,
            row.rate,
            row.amount,
          ]}
        />
      );
  }
}

/**
 * The choice (FF-1666).
 *
 * This document exists so that someone picks one option or the other, and
 * that choice used to be a row of figures in a comparison table two pages
 * before the detail — the one thing the reader came for, drawn as the
 * quietest thing on the page.
 *
 * Not boxes. A bordered panel with a fill inside it is the idiom of an
 * options dialog, and two of them side by side, each sized to its own
 * content, is why the figures in the first version did not line up with
 * each other. These are columns: a rule across the top, a label, a name,
 * and then the figure at a size that admits it is the point.
 *
 * The recommended one is said once — a heavier rule — rather than three
 * times over in a border, a fill and a word. Nothing here is coloured: the
 * same pair is drawn by the editor and the web view, and a quote that
 * suddenly grew a brand colour would look like it came from someone else.
 */
function Options({
  comparison,
  doc,
}: {
  comparison: ComparisonView;
  doc: QuoteDocument;
}) {
  const lead = comparison.rows.find((row) => row.lead);
  const rest = comparison.rows.filter((row) => !row.lead);

  return (
    <View wrap={false} style={{ flexDirection: "row", marginBottom: 24 }}>
      {comparison.columns.map((column, index) => (
        <View
          key={index.toString()}
          style={{
            flex: 1,
            marginLeft: index === 0 ? 0 : 20,
            // One signal, not three: the recommended option is the one with
            // weight on it.
            borderTopWidth: column.recommended ? 2 : 0.5,
            borderTopColor: column.recommended ? "#000" : RULE,
            paddingTop: 8,
          }}
        >
          {/* A scenario is named by its author and they already number it
              — "Optie 1 · …" — so this says only the one thing the name
              cannot. The line is kept whether it is used or not, so both
              columns start their name on the same line. */}
          <Text style={{ ...eyebrow, marginBottom: 4 }}>
            {column.recommended ? doc.labels.recommended : " "}
          </Text>
          {/* Two lines of room whether the name needs them or not, so the
              figures below land on the same line in both columns. A
              comparison whose halves do not align is not one. */}
          <View style={{ height: PRINT_BODY * 2.9, marginBottom: 10 }}>
            <Text
              style={{
                ...strong,
                lineHeight: QUOTE_TYPESET.leading.heading,
              }}
            >
              {column.name}
            </Text>
          </View>
          {lead ? (
            <Text
              style={{
                fontSize: headingSize(PRINT_BODY, 2, QUOTE_TYPESET),
                lineHeight: QUOTE_TYPESET.leading.heading,
                marginBottom: 2,
              }}
            >
              {lead.values[index]}
            </Text>
          ) : null}
          {/* A bare "106 – 153" says nothing, so a row whose label names
              the unit of its value is written as the two together. A row
              whose value speaks for itself — "Vork met plafond" — is not. */}
          <Text style={small}>
            {rest
              .map((row) =>
                row.unit
                  ? `${row.values[index]} ${row.label.toLowerCase()}`
                  : row.values[index],
              )
              .join(" · ")}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Totals({ scenario }: { scenario: ScenarioView }) {
  return (
    <View style={{ marginTop: 6, alignItems: "flex-end" }}>
      {scenario.totals.map((total) => (
        <View
          key={total.label}
          style={{
            flexDirection: "row",
            width: RATE_WIDTH + AMOUNT_WIDTH + 60,
            paddingVertical: 2,
            ...(total.strong
              ? { borderTopWidth: 0.5, borderTopColor: "#000", marginTop: 2 }
              : {}),
          }}
        >
          <Text style={{ ...(total.strong ? strong : body), flex: 1 }}>
            {total.label}
          </Text>
          <Text
            style={{
              ...(total.strong ? strong : body),
              width: AMOUNT_WIDTH + 30,
              textAlign: "right",
            }}
          >
            {total.value}
          </Text>
        </View>
      ))}
      {scenario.cappedNote ? (
        <Text style={{ ...small, marginTop: 2 }}>{scenario.cappedNote}</Text>
      ) : null}
    </View>
  );
}

/** A heading and simple rows of label and figures, kept on one page. */
function Listing({
  title,
  rows,
}: {
  title: string;
  rows: {
    key: string;
    label: ReactNode;
    quantity: string;
    rate: string;
    amount: string;
  }[];
}) {
  if (rows.length === 0) return null;
  return (
    <View wrap={false} style={{ marginTop: 12 }}>
      <Text style={{ ...small, marginBottom: 2 }}>{title}</Text>
      {rows.map((row) => (
        <Cells
          key={row.key}
          cells={[row.label, row.quantity, row.rate, row.amount]}
          style={{ borderTopWidth: 0.5, borderTopColor: RULE }}
        />
      ))}
    </View>
  );
}

function Scenario({
  scenario,
  doc,
}: {
  scenario: ScenarioView;
  doc: QuoteDocument;
}) {
  const { labels } = doc;
  const { head, middle, tail, together } = scenarioParts(scenario.rows);
  const rows = (list: ScenarioRow[], offset: number) =>
    list.map((row, index) => (
      <Row key={(offset + index).toString()} row={row} oneOff={labels.oneOff} />
    ));

  return (
    <View style={{ marginBottom: 24 }}>
      <View wrap={false}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              fontSize: headingSize(PRINT_BODY, 2, QUOTE_TYPESET),
              fontWeight: 600,
              lineHeight: QUOTE_TYPESET.leading.heading,
            }}
          >
            {scenario.name}
          </Text>
          {/* A label, not a box drawn round a word (FF-1666). */}
          {scenario.recommended ? (
            <Text style={{ ...eyebrow, marginLeft: 8 }}>
              {labels.recommended}
            </Text>
          ) : null}
        </View>
        {scenario.conditions ? (
          <Text style={{ ...small, marginTop: 2 }}>{scenario.conditions}</Text>
        ) : null}
        {/* A column heading is a label, not a cell of data — all four of
            them (FF-1666). */}
        <Cells
          cells={[
            <Text key="h" style={eyebrow}>
              {labels.description}
            </Text>,
            <Text key="q" style={eyebrow}>
              {scenario.quantityLabel}
            </Text>,
            <Text key="r" style={eyebrow}>
              {labels.rate}
            </Text>,
            <Text key="a" style={eyebrow}>
              {scenario.amountLabel}
            </Text>,
          ]}
          style={{
            marginTop: 8,
            borderBottomWidth: 0.5,
            borderBottomColor: "#000",
          }}
        />
        {rows(head, 0)}
        {together ? <Totals scenario={scenario} /> : null}
      </View>

      {rows(middle, head.length)}

      {together ? null : (
        <View wrap={false}>
          {rows(tail, head.length + middle.length)}
          <Totals scenario={scenario} />
        </View>
      )}

      <Listing
        title={labels.byProduct}
        rows={scenario.products.map((p) => ({
          key: p.name,
          label: <Text style={body}>{p.name}</Text>,
          quantity: p.quantity,
          rate: p.rate,
          amount: p.amount,
        }))}
      />

      <Listing
        title={labels.optional}
        rows={scenario.optional.map((o, index) => ({
          key: index.toString(),
          label: (
            <View>
              <Text style={body}>{o.title}</Text>
              {o.description ? (
                <Text style={{ ...small, marginTop: 1 }}>{o.description}</Text>
              ) : null}
              {o.oneOff ? (
                <Text style={{ ...small, marginTop: 1 }}>{labels.oneOff}</Text>
              ) : null}
            </View>
          ),
          quantity: o.quantity,
          rate: "",
          amount: o.amount,
        }))}
      />

      <Listing
        title={labels.paymentSchedule}
        rows={scenario.paymentSchedule.map((p, index) => ({
          key: index.toString(),
          label: <Text style={body}>{p.label}</Text>,
          quantity: "",
          rate: p.percent,
          amount: p.amount,
        }))}
      />
    </View>
  );
}

function Notes({ doc }: { doc: QuoteDocument }) {
  return (
    <View wrap={false} style={{ marginBottom: 20 }}>
      {doc.notes.map((note) => (
        <Text key={note} style={small}>
          {note}
        </Text>
      ))}
    </View>
  );
}

export function QuotePdf({ doc }: { doc: QuoteDocument }) {
  const { labels } = doc;
  const hasPricing = doc.blocks.some((b) => b.type === "pricing");
  const sections = sectionNumbers(doc);

  return (
    <Document title={`${labels.quote} ${doc.number}`}>
      <Page size="A4" wrap style={PAGE}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 24,
          }}
        >
          <View style={{ flex: 1, marginRight: 20 }}>
            {/* The title leads and the number identifies (FF-1653). They
                used to be the other way round — the number at 16pt and the
                title at 11pt — which left a quote's own name smaller than
                every section title inside it, and the number the same size
                as one. The screen has read this way since FF-1652; this is
                the print side of it. */}
            <Text style={small}>
              {labels.quote} · {doc.number}
            </Text>
            <Text
              style={{
                fontSize: documentTitleSize(PRINT_BODY),
                fontWeight: QUOTE_TYPESET.weight.documentTitle,
                lineHeight: QUOTE_TYPESET.leading.heading,
                marginTop: 2,
              }}
            >
              {doc.title}
            </Text>
            <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
              {doc.meta.map((m) => (
                <View key={m.label}>
                  <Text style={small}>{m.label}</Text>
                  <Text style={body}>{m.value}</Text>
                </View>
              ))}
            </View>
          </View>
          {doc.logoUrl ? (
            <Image
              src={doc.logoUrl}
              style={{ height: 60, maxWidth: 200, objectFit: "contain" }}
            />
          ) : null}
        </View>

        {/* On the same two columns the document below stands on (FF-1666):
            who it is from in the sidehead, who it is for at the head of the
            text column. Before this the page had three different left edges
            down it. */}
        <View style={{ flexDirection: "row", marginBottom: 20 }}>
          <View style={{ flex: 1, marginRight: 10 }}>
            <Text style={{ ...small, marginBottom: 2 }}>{labels.from}</Text>
            <Rich doc={doc.fromDetails} />
            {/* The bank account belongs with the sender's legal details. */}
            {doc.paymentDetails ? (
              <View style={{ marginTop: 6 }}>
                <Text style={{ ...small, marginBottom: 2 }}>
                  {labels.paymentDetails}
                </Text>
                <Rich doc={doc.paymentDetails} />
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={{ ...small, marginBottom: 2 }}>{labels.to}</Text>
            <Rich doc={doc.customerDetails} />
          </View>
        </View>

        <Text
          style={{
            ...body,
            marginBottom: 20,
            paddingLeft: 8,
            borderLeftWidth: 2,
            borderLeftColor: "#000",
            // Running text, so it takes the measure like the rest of it.
            width: COLUMN,
          }}
        >
          {doc.statement}
        </Text>

        {doc.blocks.map((block, index) =>
          block.type === "contents" ? (
            <View
              key={block.id}
              style={index === 0 ? undefined : { marginTop: 20 }}
            >
              <Contents doc={doc} sections={sections} />
            </View>
          ) : block.type === "text" ? (
            <View
              key={block.id}
              // From above, like everything else in the document (FF-1665).
              // A trailing margin on the last block is height past the end
              // of the text, and react-pdf will open a page to hold it.
              style={index === 0 ? undefined : { marginTop: 20 }}
            >
              {block.heading ? (
                <SectionHead
                  number={sections.get(block.id)}
                  title={block.heading}
                />
              ) : null}
              {/* Running text stops at the measure; the rule above it and
                  the tables below take the page (FF-1666). */}
              <View style={{ width: COLUMN }}>
                <Rich doc={block.body} images={doc.images} prose />
              </View>
            </View>
          ) : (
            // No forced break before the money, though it was tried
            // (FF-1666). Starting it on a clean page reads well when the
            // prose above happens to fill its page and leaves most of a
            // sheet empty when it does not — on OFF-0004, three lines of
            // section 05 and then 60% of a page of nothing.
            //
            // The whitespace at the foot of a page is the height of the
            // tallest thing that would not fit there. Everything else in
            // this document is a group small enough to bound that; a forced
            // break is the one thing with no bound at all, so there is none.
            <View
              key={block.id}
              style={index === 0 ? undefined : { marginTop: 20 }}
            >
              {block.comparison ? (
                <Options comparison={block.comparison} doc={doc} />
              ) : null}
              {block.scenarios.map((scenario) => (
                <Scenario key={scenario.id} scenario={scenario} doc={doc} />
              ))}
              <Notes doc={doc} />
            </View>
          ),
        )}

        {hasPricing ? null : <Notes doc={doc} />}

        <Footer doc={doc} />
      </Page>

      {doc.terms ? <TermsPage terms={doc.terms} doc={doc} /> : null}
    </Document>
  );
}
