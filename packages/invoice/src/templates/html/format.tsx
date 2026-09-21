import type { ReactNode } from "react";
import type { EditorDoc, EditorNode } from "../../types";
import { headingSize, TYPESET } from "../typeset";

/** What this view reads at; every other size follows from it. */
const BODY = 11;
const bodyText = "text-[11px]";

// Tailwind's reset flattens headings and lists, so every one of them carries
// its own size, weight and marker here. The size comes from the one scale
// every surface reads (FF-1651) rather than a class name, because Tailwind
// finds its classes by reading this file and a computed one would be a size
// it never generates.
const headingBlock = "font-semibold";
const listBlock = "pl-4 my-0.5";

// A table (FF-1642). `table-fixed` over a full width is what makes every
// column an equal share: left to itself the browser sizes columns by what
// they hold, and the page would then disagree with the PDF, which cannot
// measure text at all. The rule is the theme's, like every other rule on
// this view, so it holds up in the dark as well as the light.
const tableBlock = "table-fixed w-full my-1.5 border-collapse";
const tableCell = "align-top border border-border px-1.5 py-1";
// A cell's own alignment (FF-1642), written out per value because Tailwind
// finds its classes by reading this file.
const cellAlignment: Record<string, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};
// A header cell is tinted as well as bold, the same pair the editor and the
// PDF draw, so which row or column is the header reads at a glance.
const tableHeaderCell = "bg-[#F6F6F3] font-semibold dark:bg-[#1C1C1C]";

export function formatEditorContent(doc?: EditorDoc): ReactNode | null {
  if (!doc?.content) {
    return null;
  }

  return <>{doc.content.map((node, index) => renderBlock(node, `${index}`))}</>;
}

function renderBlock(node: EditorNode, path: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <p key={`paragraph-${path}`}>{renderInline(node, path, bodyText)}</p>
      );

    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
      const Heading = `h${level}` as "h1";

      return (
        <Heading
          key={`heading-${path}`}
          className={headingBlock}
          // More room above than below, so a heading belongs to what
          // follows it rather than floating between two things equally.
          style={{
            fontSize: headingSize(BODY, level),
            lineHeight: TYPESET.leading.heading,
            marginTop: BODY * TYPESET.flow.above,
            marginBottom: BODY * TYPESET.flow.below,
          }}
        >
          {renderInline(node, path, "")}
        </Heading>
      );
    }

    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? []).map((item, index) => (
        <li key={`list-item-${path}-${index.toString()}`} className={bodyText}>
          {item.content?.map((child, childIndex) =>
            renderBlock(child, `${path}-${index}-${childIndex}`),
          )}
        </li>
      ));

      if (node.type === "orderedList") {
        const start = node.attrs?.start ?? 1;
        return (
          <ol
            key={`list-${path}`}
            className={`list-decimal ${listBlock}`}
            // A list continuing an earlier one starts where it left off.
            start={start === 1 ? undefined : start}
          >
            {items}
          </ol>
        );
      }

      return (
        <ul key={`list-${path}`} className={`list-disc ${listBlock}`}>
          {items}
        </ul>
      );
    }

    case "table": {
      const lines = node.content ?? [];
      // A table with no rows is an empty box; leave it out.
      if (lines.length === 0) {
        return null;
      }

      return (
        <table key={`table-${path}`} className={tableBlock}>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`table-row-${path}-${index.toString()}`}>
                {(line.content ?? []).map((cell, cellIndex) => {
                  const span = Math.max(1, cell.attrs?.colspan ?? 1);
                  const Cell = cell.type === "tableHeader" ? "th" : "td";
                  const across =
                    cellAlignment[cell.attrs?.align ?? "left"] ?? "text-left";
                  return (
                    <Cell
                      key={`table-cell-${path}-${index.toString()}-${cellIndex.toString()}`}
                      colSpan={span === 1 ? undefined : span}
                      className={
                        Cell === "th"
                          ? `${tableCell} ${bodyText} ${across} ${tableHeaderCell}`
                          : `${tableCell} ${bodyText} ${across}`
                      }
                    >
                      {cell.content?.map((child, childIndex) =>
                        renderBlock(
                          child,
                          `${path}-${index}-${cellIndex}-${childIndex}`,
                        ),
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

    // A picture (FF-1625) is quotes-only, and a quote has no web view — it
    // reaches its client as a PDF. A diagram (FF-1643) is a picture by the
    // time it gets here, so it is drawn on exactly the same terms: nothing,
    // for now, and whatever gives this view pictures gives it diagrams.
    default:
      return null;
  }
}

function renderInline(node: EditorNode, path: string, baseText: string) {
  return node.content?.map((inlineContent, inlineIndex) => {
    if (inlineContent.type === "text") {
      let style = baseText;
      let href: string | undefined;
      let hasUnderline = false;
      let hasStrike = false;

      for (const mark of inlineContent.marks ?? []) {
        if (mark.type === "bold") {
          style += " font-semibold";
        } else if (mark.type === "italic") {
          style += " italic";
        } else if (mark.type === "link") {
          href = mark.attrs?.href;
          hasUnderline = true;
        } else if (mark.type === "underline") {
          hasUnderline = true;
        } else if (mark.type === "strike") {
          hasStrike = true;
        }
      }

      const content = inlineContent.text || "";
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(content);
      const isLink = Boolean(href) || isEmail;

      // Tailwind's `underline` and `line-through` set the same property, so
      // one would win over the other; text carrying both needs the pair
      // written out.
      if ((hasUnderline || isLink) && hasStrike) {
        style += " [text-decoration-line:underline_line-through]";
      } else if (hasUnderline || isLink) {
        style += " underline";
      } else if (hasStrike) {
        style += " line-through";
      }

      if (isLink) {
        const linkHref = href || (isEmail ? `mailto:${content}` : content);
        return (
          <a
            key={`link-${path}-${inlineIndex.toString()}`}
            href={linkHref}
            className={style}
          >
            {content}
          </a>
        );
      }

      return (
        <span key={`text-${path}-${inlineIndex.toString()}`} className={style}>
          {content}
        </span>
      );
    }

    if (inlineContent.type === "hardBreak") {
      return <br key={`break-${path}-${inlineIndex.toString()}`} />;
    }

    return null;
  });
}
