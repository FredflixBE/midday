import { Image, Link, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";
import type { EditorDoc, EditorNode } from "../../types";

type PDFTextStyle = Style & {
  fontFamily?: string;
  fontStyle?: "normal" | "italic" | "oblique";
  textDecoration?:
    | "none"
    | "underline"
    | "line-through"
    | "underline line-through";
};

const bodyText: PDFTextStyle = { fontSize: 9, fontFamily: "Inter" };

// Headings by level; the editor allows 1 to 6, and 3 and below read alike.
const headingSizes: Record<number, number> = { 1: 14, 2: 12 };
const smallestHeadingSize = 10;

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
};

export function formatEditorContent(doc?: EditorDoc, options?: FormatOptions) {
  if (!doc?.content) {
    return null;
  }

  return (
    <>
      {doc.content.map((node, index) => renderBlock(node, `${index}`, options))}
    </>
  );
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
): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <View key={`paragraph-${path}`} style={{ alignItems: "flex-start" }}>
          <Text>{renderInline(node, path, base)}</Text>
        </View>
      );

    case "heading": {
      const size = headingSizes[node.attrs?.level ?? 1] ?? smallestHeadingSize;
      return (
        <View
          key={`heading-${path}`}
          style={{ alignItems: "flex-start", marginTop: 6, marginBottom: 3 }}
          minPresenceAhead={24}
        >
          <Text>
            {renderInline(node, path, {
              ...base,
              fontSize: size,
              fontWeight: 600,
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
        <View key={`list-${path}`} style={{ marginVertical: 2 }}>
          {items.map((item, index) => (
            <View
              key={`list-item-${path}-${index.toString()}`}
              style={{ flexDirection: "row" }}
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
                  ),
                )}
              </View>
            </View>
          ))}
        </View>
      );
    }

    case "image": {
      const stored = node.attrs?.path;
      const source = stored ? options?.imageOf?.(stored) : null;
      if (!source) {
        return null;
      }

      return (
        // The text column's full width, its own proportions, and never
        // divided over two pages.
        <View key={`image-${path}`} style={{ marginVertical: 6 }} wrap={false}>
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
  const base = heading ? { ...bodyText, fontWeight: 600 } : bodyText;

  return (
    <View
      key={`table-cell-${path}`}
      style={{
        flexGrow: span,
        flexBasis: 0,
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
