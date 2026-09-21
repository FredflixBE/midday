// The same document the web invoice view and the PDF are drawn from, so a
// preview cannot drift from the page by describing it differently.
import type { EditorDoc, EditorNode } from "@midday/invoice/types";

const bodySize = 11;

// Headings by level; the editor allows 1 to 6, and 3 and below read alike.
// The sizes are the web invoice view's, so a preview reads like the page.
const headingSizes: Record<number, number> = { 1: 17, 2: 15 };
const smallestHeadingSize = 12;

function nodeKey(node: EditorNode, index: number): string {
  const text =
    node.content
      ?.map((c) => c.text ?? c.type)
      .join("")
      .slice(0, 32) ?? "";
  return `${node.type}-${text || index}`;
}

function inlineKey(
  inline: EditorNode,
  parentKey: string,
  index: number,
): string {
  if (inline.type === "hardBreak") return `${parentKey}-br-${index}`;
  return `${parentKey}-${inline.text?.slice(0, 24) ?? inline.type}-${index}`;
}

function renderBlock(node: EditorNode, index: number): React.ReactNode {
  const key = nodeKey(node, index);

  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className="m-0 min-h-[1em]">
          {renderInline(node, key, { fontSize: bodySize })}
        </p>
      );

    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
      const style: React.CSSProperties = {
        fontSize: headingSizes[level] ?? smallestHeadingSize,
        fontWeight: 600,
      };
      const Heading = `h${level}` as "h1";

      return (
        <Heading key={key} className="mt-1.5 mb-0.5" style={style}>
          {renderInline(node, key, style)}
        </Heading>
      );
    }

    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? []).map((item, itemIndex) => (
        <li
          key={`${key}-item-${itemIndex.toString()}`}
          style={{ fontSize: bodySize }}
        >
          {item.content?.map((child, childIndex) =>
            renderBlock(child, childIndex),
          )}
        </li>
      ));

      if (node.type === "orderedList") {
        const start = node.attrs?.start ?? 1;
        return (
          <ol
            key={key}
            className="list-decimal pl-4 my-0.5"
            // A list continuing an earlier one starts where it left off.
            start={start === 1 ? undefined : start}
          >
            {items}
          </ol>
        );
      }

      return (
        <ul key={key} className="list-disc pl-4 my-0.5">
          {items}
        </ul>
      );
    }

    case "table": {
      const lines = node.content ?? [];
      // A table with no rows is an empty box; leave it out.
      if (lines.length === 0) return null;

      return (
        // `table-fixed` over a full width gives every column an equal share,
        // which is what the PDF and the web view draw: left to itself the
        // browser would size the columns by what they hold, and the preview
        // would disagree with the page it is previewing.
        <table key={key} className="table-fixed w-full my-1.5 border-collapse">
          <tbody>
            {lines.map((line, lineIndex) => (
              <tr key={`${key}-row-${lineIndex.toString()}`}>
                {(line.content ?? []).map((cell, cellIndex) => {
                  const span = Math.max(1, cell.attrs?.colspan ?? 1);
                  const Cell = cell.type === "tableHeader" ? "th" : "td";
                  return (
                    <Cell
                      key={`${key}-cell-${lineIndex.toString()}-${cellIndex.toString()}`}
                      colSpan={span === 1 ? undefined : span}
                      className="align-top text-left border border-border px-1.5 py-1"
                      style={{
                        fontSize: bodySize,
                        ...(Cell === "th" ? { fontWeight: 600 } : {}),
                      }}
                    >
                      {cell.content?.map((child, childIndex) =>
                        renderBlock(child, childIndex),
                      )}
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    // A picture (FF-1625) is quotes-only, and this previews an invoice.
    default:
      return null;
  }
}

function renderInline(
  node: EditorNode,
  parentKey: string,
  base: React.CSSProperties,
): React.ReactNode {
  return node.content?.map((inline, index) => {
    const key = inlineKey(inline, parentKey, index);

    if (inline.type === "text") {
      const style: React.CSSProperties = { ...base };
      let hasUnderline = false;
      let hasStrike = false;

      for (const mark of inline.marks ?? []) {
        if (mark.type === "bold") style.fontWeight = 600;
        else if (mark.type === "italic") style.fontStyle = "italic";
        else if (mark.type === "link" || mark.type === "underline")
          hasUnderline = true;
        else if (mark.type === "strike") hasStrike = true;
      }

      // Both marks at once are one declaration, not two that overwrite.
      if (hasUnderline && hasStrike)
        style.textDecoration = "underline line-through";
      else if (hasUnderline) style.textDecoration = "underline";
      else if (hasStrike) style.textDecoration = "line-through";

      return (
        <span key={key} style={style}>
          {inline.text || ""}
        </span>
      );
    }

    if (inline.type === "hardBreak") {
      return <br key={key} />;
    }

    return null;
  });
}

function formatEditorContent(doc?: EditorDoc): React.ReactNode | null {
  if (!doc?.content) return null;

  return <>{doc.content.map((node, index) => renderBlock(node, index))}</>;
}

type Props = {
  content?: EditorDoc | null;
};

export function EditorContent({ content }: Props) {
  if (!content) return null;
  return <div className="leading-[16px]">{formatEditorContent(content)}</div>;
}
