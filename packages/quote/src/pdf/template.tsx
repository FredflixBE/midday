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
const COLUMN = measureWidth(PRINT_BODY);

const GREY = "#606060";
const RULE = "#DCDAD2";
/* The same tint a table header is drawn on, here and in the editor and the
   web view alike — a quote has one, and this is it (FF-1642). */
const TINT = "#F6F6F3";

/* The proportion it always had to the body: 8 against 9. */
const small: Style = { fontSize: PRINT_BODY * 0.89, color: GREY };
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
    <View wrap={false} style={{ width: COLUMN, marginBottom: 24 }}>
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

function SectionHead({ number, title }: { number?: string; title: string }) {
  return (
    // Never split, and never the last thing on a page: a rule at the foot
    // of one page with its title at the head of the next is worse than no
    // rule at all. `wrap` keeps the three lines together and
    // `minPresenceAhead` keeps them with the text they introduce.
    <View
      wrap={false}
      minPresenceAhead={90}
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
          fontSize: blockHeadingSize(PRINT_BODY),
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
}) {
  if (!doc) return null;
  const scale = prose ? QUOTE_TYPESET : TYPESET;
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
 * The choice, as two panels (FF-1666).
 *
 * This document exists so that someone picks one option or the other, and
 * until now that choice was a row of figures in a comparison table two
 * pages before the detail — the one thing the reader came for, drawn as the
 * quietest thing on the page.
 *
 * A panel each, side by side, holding exactly what the decision turns on:
 * what the option is called, what it costs, how long it takes, and which
 * one is being recommended. The line items still follow underneath for
 * whoever wants to check the arithmetic.
 *
 * The recommended one is drawn on a tint rather than in a second colour.
 * The same pair is drawn by the editor and the web view, and a quote that
 * suddenly grew a brand colour would look like it came from someone else.
 */
function Options({
  comparison,
  doc,
}: {
  comparison: ComparisonView;
  doc: QuoteDocument;
}) {
  return (
    <View wrap={false} style={{ marginBottom: 20 }}>
      <View style={{ flexDirection: "row" }}>
        {comparison.columns.map((column, index) => (
          <View
            key={index.toString()}
            style={{
              flex: 1,
              padding: 10,
              borderWidth: 0.5,
              borderColor: column.recommended ? "#000" : RULE,
              backgroundColor: column.recommended ? TINT : "#fff",
              marginLeft: index === 0 ? 0 : 8,
            }}
          >
            <Text style={{ ...small, marginBottom: 3 }}>
              {column.recommended ? doc.labels.recommended : " "}
            </Text>
            <Text
              style={{
                ...strong,
                fontSize: headingSize(PRINT_BODY, 3, QUOTE_TYPESET),
                lineHeight: QUOTE_TYPESET.leading.heading,
                marginBottom: 6,
              }}
            >
              {column.name}
            </Text>
            {comparison.rows.map((row) => (
              <View
                key={row.label}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  paddingVertical: 2,
                  borderTopWidth: 0.5,
                  borderTopColor: RULE,
                }}
              >
                <Text style={{ ...small, marginRight: 8 }}>{row.label}</Text>
                <Text style={{ ...body, textAlign: "right" }}>
                  {row.values[index]}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
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
          {scenario.recommended ? (
            <Text
              style={{
                ...small,
                borderWidth: 0.5,
                borderColor: GREY,
                paddingHorizontal: 4,
                paddingVertical: 1,
              }}
            >
              {labels.recommended}
            </Text>
          ) : null}
        </View>
        {scenario.conditions ? (
          <Text style={{ ...small, marginTop: 2 }}>{scenario.conditions}</Text>
        ) : null}
        <Cells
          cells={[
            <Text key="h" style={small}>
              {labels.description}
            </Text>,
            scenario.quantityLabel,
            labels.rate,
            scenario.amountLabel,
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
      <Page
        size="A4"
        wrap
        style={{
          paddingTop: 36,
          paddingBottom: 48,
          paddingHorizontal: 40,
          fontFamily: "Inter",
          fontWeight: 400,
          color: "#000",
          backgroundColor: "#fff",
        }}
      >
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

        <Contents doc={doc} sections={sections} />

        {doc.blocks.map((block) =>
          block.type === "text" ? (
            <View key={block.id} style={{ marginBottom: 20 }}>
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
            <View key={block.id}>
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
              fill(labels.page, { page: pageNumber, pages: totalPages })
            }
          />
        </View>
      </Page>
    </Document>
  );
}
