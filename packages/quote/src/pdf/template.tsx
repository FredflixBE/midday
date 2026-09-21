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

const GREY = "#606060";
const RULE = "#DCDAD2";

const small: Style = { fontSize: 8, color: GREY };
const body: Style = { fontSize: 9 };
const strong: Style = { fontSize: 9, fontWeight: 600 };

// Line columns: description, quantity, rate, amount.
const QUANTITY_WIDTH = 64;
const RATE_WIDTH = 84;
const AMOUNT_WIDTH = 124;

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
        fontSize: 9,
        lineHeight: scale.leading.body,
        maxWidth: measureWidth(9),
      }}
    >
      {/* The same Tiptap shape, typed loosely on this side. */}
      {formatEditorContent(doc as unknown as InvoiceEditorDoc, {
        imageOf: (path) => images?.[path] ?? null,
        // Both, as before: whether an address wants room under each of its
        // lines is a question this change does not open.
        spacedParagraphs: true,
        scale,
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

function Comparison({
  comparison,
  doc,
}: {
  comparison: ComparisonView;
  doc: QuoteDocument;
}) {
  return (
    <View wrap={false} style={{ marginBottom: 20 }}>
      <Text
        style={{
          fontSize: headingSize(9, 2, QUOTE_TYPESET),
          fontWeight: 600,
          lineHeight: QUOTE_TYPESET.leading.heading,
          marginBottom: 6,
        }}
      >
        {doc.labels.comparison}
      </Text>
      <View
        style={{
          flexDirection: "row",
          borderBottomWidth: 0.5,
          borderBottomColor: RULE,
          paddingBottom: 4,
        }}
      >
        <View style={{ flex: 1.2 }} />
        {comparison.columns.map((column, index) => (
          <View key={index.toString()} style={{ flex: 1, paddingLeft: 8 }}>
            <Text style={{ ...strong, textAlign: "right" }}>{column.name}</Text>
            {column.recommended ? (
              <Text style={{ ...small, textAlign: "right" }}>
                {doc.labels.recommended}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      {comparison.rows.map((row) => (
        <View
          key={row.label}
          style={{
            flexDirection: "row",
            paddingVertical: 3,
            borderBottomWidth: 0.5,
            borderBottomColor: RULE,
          }}
        >
          <Text style={{ ...body, flex: 1.2, color: GREY }}>{row.label}</Text>
          {row.values.map((value, index) => (
            <Text
              key={index.toString()}
              style={{ ...body, flex: 1, paddingLeft: 8, textAlign: "right" }}
            >
              {value}
            </Text>
          ))}
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
              fontSize: headingSize(9, 2, QUOTE_TYPESET),
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
                fontSize: documentTitleSize(9),
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
            maxWidth: measureWidth(9),
          }}
        >
          {doc.statement}
        </Text>

        {doc.blocks.map((block) =>
          block.type === "text" ? (
            <View key={block.id} style={{ marginBottom: 16 }}>
              {block.heading ? (
                <Text
                  minPresenceAhead={40}
                  // A block's title sits above every heading its text can
                  // hold (FF-1651). It used to be drawn at exactly an h1's
                  // size, so a section's title and a heading inside it were
                  // the same thing to look at.
                  style={{
                    fontSize: blockHeadingSize(9),
                    fontWeight: QUOTE_TYPESET.weight.blockHeading,
                    lineHeight: QUOTE_TYPESET.leading.heading,
                    // The one bottom margin in the document, and it is
                    // safe to be one: a title stands outside the text, and
                    // the first block of that text takes no room above it,
                    // so nothing meets this (FF-1665).
                    marginBottom: 9 * QUOTE_TYPESET.flow.below,
                    // The title sits over its own text, not over the page.
                    maxWidth: measureWidth(9),
                  }}
                >
                  {block.heading}
                </Text>
              ) : null}
              <Rich doc={block.body} images={doc.images} prose />
            </View>
          ) : (
            <View key={block.id}>
              {block.comparison ? (
                <Comparison comparison={block.comparison} doc={doc} />
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
