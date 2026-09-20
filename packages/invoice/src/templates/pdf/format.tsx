import { Link, Text, View } from "@react-pdf/renderer";
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

// The cell that holds a list item's bullet or number: a bullet's width, or
// room for the list's longest number, so every item's text lines up.
const bulletWidth = 12;
const digitWidth = 5;

export function formatEditorContent(doc?: EditorDoc) {
  if (!doc?.content) {
    return null;
  }

  return <>{doc.content.map((node, index) => renderBlock(node, `${index}`))}</>;
}

function renderBlock(node: EditorNode, path: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <View key={`paragraph-${path}`} style={{ alignItems: "flex-start" }}>
          <Text>{renderInline(node, path, bodyText)}</Text>
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
              ...bodyText,
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
              <Text style={{ ...bodyText, width: markerWidth }}>
                {markerOf(index)}
              </Text>
              <View style={{ flex: 1 }}>
                {item.content?.map((child, childIndex) =>
                  renderBlock(child, `${path}-${index}-${childIndex}`),
                )}
              </View>
            </View>
          ))}
        </View>
      );
    }

    default:
      return null;
  }
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
