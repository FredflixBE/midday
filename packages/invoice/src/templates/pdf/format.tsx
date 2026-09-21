import { Image, Link, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";
import type { EditorDoc, EditorNode } from "../../types";
import { headingSize, TYPESET, type Typeset } from "../typeset";

type PDFTextStyle = Style & {
  fontFamily?: string;
  fontStyle?: "normal" | "italic" | "oblique";
  textDecoration?:
    | "none"
    | "underline"
    | "line-through"
    | "underline line-through";
};

/** What the printed document reads at; every other size follows from it. */
const BODY = 9;
// No leading here: this is shared with an invoice's address blocks, where
// the caller sets it. The quote's own wrapper sets the document's.
const bodyText: PDFTextStyle = { fontSize: BODY, fontFamily: "Inter" };

// A picture is drawn the width of the text column, but a tall one drawn to
// that width would run off the foot of the page — a phone screenshot is
// twice as tall as it is wide. This leaves it room to stand whole on a page
// of its own, and a taller one is fitted inside rather than cut.
const maxImageHeight = 560;

// The cell that holds a list item's bullet or number: a bullet's width, or
// room for the list's longest number, so every item's text lines up.
const bulletWidth = 12;
const digitWidth = 5;

// A table's rules, and the room a cell keeps from them. The same grey the
// quote PDF rules its own line table with, so a written table and a priced
// one read as the same document rather than two.
//
// A line on every edge, not only under each row: a grid with no verticals
// reads as a list of sentences, and the editor draws all four (FF-1642).
const tableRuleColor = "#DCDAD2";
const tableRuleWidth = 0.5;
// A header cell is tinted as well as bold, so which row or column is the
// header reads at a glance. The same grey the editor and the web view use.
const tableHeaderFill = "#F6F6F3";
// Where a cell's content sits across it, as react-pdf says it.
const cellAlignment: Record<string, "flex-start" | "center" | "flex-end"> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};
const cellPaddingVertical = 3;
const cellPaddingHorizontal = 4;

/**
 * What a picture stored under a path looks like to react-pdf: the bytes,
 * because the PDF is drawn on the server and a stored path is not an address
 * anything can fetch. A path with nothing behind it is left out rather than
 * failing the whole document.
 */
export type ImageSource = { data: Buffer; format: "png" | "jpg" };

export type FormatOptions = {
  /** The bytes behind a stored path, or null when there are none. */
  imageOf?: (storedPath: string) => ImageSource | null;
  /**
   * True puts room under every paragraph (FF-1652).
   *
   * Off by default, and deliberately: this draws an invoice's `from` and
   * customer address blocks as well as a quote's text, and an address is a
   * list of lines rather than a run of paragraphs. Spacing one out reads as
   * a mistake. A document that is actually prose asks for it.
   */
  spacedParagraphs?: boolean;
  /**
   * What a heading inside the text is set in. Left alone it is 600, which
   * is what every caller drew before there was a scale to read — an invoice
   * note is unchanged.
   */
  headingWeight?: number;
  /**
   * Which document's rhythm this text is set in (FF-1663). Left alone it is
   * the invoice's, which is what every surface but a quote's draws: a note
   * at the foot of a page and two address blocks. A quote passes its own,
   * because a quote is a document and outgrew that rhythm.
   */
  scale?: Typeset;
};

export function formatEditorContent(doc?: EditorDoc, options?: FormatOptions) {
  if (!doc?.content) {
    return null;
  }

  return (
    <>
      {doc.content.map((node, index) =>
        renderBlock(node, `${index}`, options, bodyText, {
          first: index === 0,
          afterHeading: doc.content?.[index - 1]?.type === "heading",
        }),
      )}
    </>
  );
}

/**
 * Where a block stands among its siblings, which is all it needs to know to
 * work out the room above it (FF-1665).
 */
type Position = {
  /** First of its container, so it opens at the top rather than below a gap. */
  first?: boolean;
  /** The block above is a heading, and a heading owns the room beneath it. */
  afterHeading?: boolean;
  /** Inside a list item, where the item's own margin is the room. */
  inItem?: boolean;
};

/**
 * The room above a block, and there is never any below it.
 *
 * react-pdf has no margin collapsing: two margins that meet are added, where
 * a browser takes the larger. shadcn/typeset does not rely on collapsing
 * either — "spacing flows in one direction, using margin-block-start only" —
 * so this follows the same rule and the question never arises (FF-1665).
 */
function roomAbove(
  node: EditorNode,
  options: FormatOptions | undefined,
  at: Position,
): number {
  if (at.inItem || at.first) {
    return 0;
  }
  const scale = options?.scale ?? TYPESET;
  if (at.afterHeading) {
    return BODY * scale.flow.below;
  }
  if (node.type === "heading") {
    return BODY * scale.flow.above;
  }
  // Only a document spaces its paragraphs; an address is a list of lines.
  return options?.spacedParagraphs ? BODY * scale.flow.paragraph : 0;
}

/** Omitted entirely when it is nothing, so a block's style reads as it did. */
function above(room: number) {
  return room ? { marginTop: room } : {};
}

/**
 * @param base What plain text in this block reads as. It is `bodyText`
 * everywhere but inside a table's header row, which is what carries the
 * weight down to the text itself — react-pdf inherits some of a View's text
 * styles and not others, so the weight is put where it cannot be lost.
 */
function renderBlock(
  node: EditorNode,
  path: string,
  options?: FormatOptions,
  base: PDFTextStyle = bodyText,
  at: Position = {},
): ReactNode {
  const room = above(roomAbove(node, options, at));

  switch (node.type) {
    case "paragraph":
      return (
        <View
          key={`paragraph-${path}`}
          // Room above every paragraph of a document (FF-1652). Without it
          // a block of three reads as one grey slab with line breaks in it,
          // which no amount of heading size fixes.
          style={{ alignItems: "flex-start", ...room }}
        >
          <Text>{renderInline(node, path, base)}</Text>
        </View>
      );

    case "heading": {
      const scale = options?.scale ?? TYPESET;
      const size = headingSize(BODY, node.attrs?.level ?? 1, scale);
      return (
        <View
          key={`heading-${path}`}
          // A heading takes more above than below, so it belongs to what
          // follows it rather than floating between two things equally. The
          // room below is the next block's to take (FF-1665).
          style={{ alignItems: "flex-start", ...room }}
          minPresenceAhead={24}
        >
          <Text>
            {renderInline(node, path, {
              ...base,
              fontSize: size,
              fontWeight: options?.headingWeight ?? 600,
              lineHeight: scale.leading.heading,
            })}
          </Text>
        </View>
      );
    }

    case "bulletList":
    case "orderedList": {
      const start = node.attrs?.start ?? 1;
      const items = node.content ?? [];
      const markerOf = (index: number) =>
        node.type === "bulletList" ? "•" : `${start + index}.`;
      const markerWidth =
        node.type === "bulletList"
          ? bulletWidth
          : bulletWidth + digitWidth * (markerOf(items.length - 1).length - 2);

      return (
        <View key={`list-${path}`} style={room}>
          {items.map((item, index) => (
            <View
              key={`list-item-${path}-${index.toString()}`}
              // The gap between items is the item's, not its paragraph's: a
              // bullet spaced like a paragraph is what made the print read
              // loose against the screen (FF-1665).
              style={{
                flexDirection: "row",
                ...above(
                  index === 0
                    ? 0
                    : BODY * (options?.scale ?? TYPESET).flow.item,
                ),
              }}
              // An item is a thought; it does not straddle two pages.
              wrap={false}
            >
              <Text style={{ ...base, width: markerWidth }}>
                {markerOf(index)}
              </Text>
              <View style={{ flex: 1 }}>
                {item.content?.map((child, childIndex) =>
                  renderBlock(
                    child,
                    `${path}-${index}-${childIndex}`,
                    options,
                    base,
                    // The paragraph in an item, and a nested list under it,
                    // take nothing: the item above already made the room.
                    { inItem: true },
                  ),
                )}
              </View>
            </View>
          ))}
        </View>
      );
    }

    // A diagram (FF-1643) is drawn to a picture when it is written, so by
    // the time it reaches a renderer there is nothing left to draw. Its
    // mermaid source is what makes it editable again and is never printed.
    case "diagram":
    case "image": {
      const stored = node.attrs?.path;
      const source = stored ? options?.imageOf?.(stored) : null;
      if (!source) {
        return null;
      }

      return (
        // The text column's full width, its own proportions, and never
        // divided over two pages.
        <View
          key={`${node.type}-${path}`}
          style={{ marginVertical: 6 }}
          wrap={false}
        >
          <Image
            src={source}
            style={{
              width: "100%",
              maxHeight: maxImageHeight,
              objectFit: "contain",
            }}
          />
        </View>
      );
    }

    case "table": {
      const lines = node.content ?? [];
      // A table with no rows is a box with nothing in it; leave it out, the
      // way a picture with no bytes behind it is left out.
      if (lines.length === 0) {
        return null;
      }

      return (
        // The text column's full width, always: a table is never wider than
        // the words around it, so nothing can run off the side of the page.
        // It may break between rows — a feature matrix can be longer than a
        // page — but it does not start with only a sliver of room left.
        <View
          key={`table-${path}`}
          style={{
            width: "100%",
            marginVertical: 6,
            // Each cell draws its own right and bottom line, so the grid
            // needs its top and left edge closing.
            borderTopWidth: tableRuleWidth,
            borderTopColor: tableRuleColor,
            borderLeftWidth: tableRuleWidth,
            borderLeftColor: tableRuleColor,
          }}
          minPresenceAhead={40}
        >
          {lines.map((line, index) =>
            renderTableRow(line, `${path}-${index}`, options),
          )}
        </View>
      );
    }

    default:
      return null;
  }
}

function renderTableRow(
  row: EditorNode,
  path: string,
  options?: FormatOptions,
): ReactNode {
  return (
    // Whole: a row divided over two pages reads as two different rows.
    <View
      key={`table-row-${path}`}
      wrap={false}
      style={{ flexDirection: "row" }}
    >
      {(row.content ?? []).map((cell, index) =>
        renderTableCell(cell, `${path}-${index}`, options),
      )}
    </View>
  );
}

function renderTableCell(
  cell: EditorNode,
  path: string,
  options?: FormatOptions,
): ReactNode {
  // Every column takes the same share of the text column. Nothing here is
  // measured against what a cell holds: react-pdf cannot measure text before
  // it draws it, and a width that differed from the editor's would make the
  // PDF disagree with what was written.
  const span = Math.max(1, cell.attrs?.colspan ?? 1);
  const heading = cell.type === "tableHeader";
  // A cell's own alignment (FF-1642). The cell is a column of blocks, so
  // where its content sits across it is `alignItems` — the blocks inside
  // shrink to their content rather than filling the cell.
  const across = cellAlignment[cell.attrs?.align ?? "left"] ?? "flex-start";
  const base = heading ? { ...bodyText, fontWeight: 600 } : bodyText;

  return (
    <View
      key={`table-cell-${path}`}
      style={{
        flexGrow: span,
        flexBasis: 0,
        alignItems: across,
        ...(heading ? { backgroundColor: tableHeaderFill } : {}),
        paddingVertical: cellPaddingVertical,
        paddingHorizontal: cellPaddingHorizontal,
        borderRightWidth: tableRuleWidth,
        borderRightColor: tableRuleColor,
        borderBottomWidth: tableRuleWidth,
        borderBottomColor: tableRuleColor,
      }}
    >
      {cell.content?.map((child, index) =>
        renderBlock(child, `${path}-${index}`, options, base),
      )}
    </View>
  );
}

function renderInline(node: EditorNode, path: string, base: PDFTextStyle) {
  return node.content?.map((inlineContent, inlineIndex) => {
    if (inlineContent.type === "text") {
      const style: PDFTextStyle = { ...base };
      let href: string | undefined;
      let hasUnderline = false;
      let hasStrike = false;

      if (inlineContent.marks) {
        for (const mark of inlineContent.marks) {
          if (mark.type === "bold") {
            style.fontWeight = 600;
          }
          if (mark.type === "italic") {
            style.fontStyle = "italic";
          }
          if (mark.type === "link") {
            href = mark.attrs?.href;
            hasUnderline = true;
          }
          if (mark.type === "underline") {
            hasUnderline = true;
          }
          if (mark.type === "strike") {
            hasStrike = true;
          }
        }
      }

      // Combine text decorations
      if (hasUnderline && hasStrike) {
        style.textDecoration = "underline line-through";
      } else if (hasUnderline) {
        style.textDecoration = "underline";
      } else if (hasStrike) {
        style.textDecoration = "line-through";
      }

      const content = inlineContent.text || "";
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(content);

      if (href || isEmail) {
        const linkHref = href || (isEmail ? `mailto:${content}` : content);

        return (
          <Link
            key={`link-${path}-${inlineIndex.toString()}`}
            src={linkHref}
            style={{
              ...style,
              color: "black",
              textDecoration: "underline",
            }}
          >
            {content}
          </Link>
        );
      }

      return (
        <Text key={`text-${path}-${inlineIndex.toString()}`} style={style}>
          {content}
        </Text>
      );
    }

    if (inlineContent.type === "hardBreak") {
      // This is a hack to force a line break in the PDF to look like the web editor
      return (
        <Text
          key={`hard-break-${path}-${inlineIndex.toString()}`}
          style={{ height: 12, fontSize: 12 }}
        >
          {"\n"}
        </Text>
      );
    }

    return null;
  });
}
