import type { ReactNode } from "react";
import type { EditorDoc, EditorNode } from "../../types";

export function formatEditorContent(doc?: EditorDoc) {
  if (!doc?.content) {
    return null;
  }

  return (
    <div tw="flex flex-col text-white">
      {doc.content.map((node, index) => renderBlock(node, `${index}`))}
    </div>
  );
}

/**
 * The card carries the from and customer address blocks only, drawn at
 * 1200×630 — so a heading is not sized up here, and a list or a table is
 * given no markers, indent or grid, which at that size would read as noise.
 * What the card does owe is the words: a block it did not know used to be
 * dropped whole, and every line in it with it.
 */
function renderBlock(node: EditorNode, path: string): ReactNode {
  if (
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "listItem" ||
    // A table (FF-1642) draws no grid here either — the card has no room for
    // one — but its cells hold words, and a block walked past is a block
    // whose words go with it.
    node.type === "table" ||
    node.type === "tableRow" ||
    node.type === "tableCell" ||
    node.type === "tableHeader"
  ) {
    return node.content?.map((child, index) =>
      renderBlock(child, `${path}-${index}`),
    );
  }

  return (
    <p key={`block-${path}`} tw="flex flex-col mb-0">
      {renderInline(node, path)}
    </p>
  );
}

function renderInline(node: EditorNode, path: string) {
  return node.content?.map((inlineContent, inlineIndex) => {
    if (inlineContent.type === "text") {
      let style = "text-[22px]";
      let hasUnderline = false;
      let hasStrike = false;

      if (node.type === "heading") {
        style += " font-medium";
      }

      for (const mark of inlineContent.marks ?? []) {
        if (mark.type === "bold") {
          style += " font-medium";
        } else if (mark.type === "italic") {
          style += " italic";
        } else if (mark.type === "link" || mark.type === "underline") {
          hasUnderline = true;
        } else if (mark.type === "strike") {
          hasStrike = true;
        }
      }

      // Written out rather than left to a class, because what draws this
      // card reads a narrow slice of Tailwind. The property is left off
      // entirely when there is no decoration: the renderer trims whatever
      // value it is handed, and an explicit undefined throws.
      const decoration = [
        hasUnderline ? "underline" : null,
        hasStrike ? "line-through" : null,
      ]
        .filter(Boolean)
        .join(" ");

      if (inlineContent.text) {
        return (
          <span
            key={`text-${path}-${inlineIndex.toString()}`}
            tw={style}
            style={{
              fontFamily: "hedvig-sans",
              ...(decoration ? { textDecoration: decoration } : {}),
            }}
          >
            {inlineContent.text}
          </span>
        );
      }
    }

    if (inlineContent.type === "hardBreak") {
      return <br key={`break-${path}-${inlineIndex.toString()}`} />;
    }

    return null;
  });
}
