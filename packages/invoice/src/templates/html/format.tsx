import type { ReactNode } from "react";
import type { EditorDoc, EditorNode } from "../../types";

const bodyText = "text-[11px]";

// Headings by level; the editor allows 1 to 6, and 3 and below read alike.
// The steps follow the PDF's (14, 12 and 10 against a 9pt body), scaled to
// the 11px this view reads at, so a heading is the same size on both.
//
// Written out as whole class names rather than built from the numbers,
// because Tailwind finds classes by reading this file: a size it never sees
// spelled out is a size it never generates.
const headingText: Record<number, string> = {
  1: "text-[17px]",
  2: "text-[15px]",
};
const smallestHeadingText = "text-[12px]";

// Tailwind's reset flattens headings and lists, so every one of them carries
// its own size, weight and marker here.
const headingBlock = "font-semibold mt-1.5 mb-0.5";
const listBlock = "pl-4 my-0.5";

// A table (FF-1642). `table-fixed` over a full width is what makes every
// column an equal share: left to itself the browser sizes columns by what
// they hold, and the page would then disagree with the PDF, which cannot
// measure text at all. The rule is the theme's, like every other rule on
// this view, so it holds up in the dark as well as the light.
const tableBlock = "table-fixed w-full my-1.5 border-collapse";
const tableCell = "align-top text-left border border-border px-1.5 py-1";

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
      const size = headingText[level] ?? smallestHeadingText;
      const Heading = `h${level}` as "h1";

      return (
        <Heading key={`heading-${path}`} className={`${size} ${headingBlock}`}>
          {renderInline(node, path, size)}
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
                  return (
                    <Cell
                      key={`table-cell-${path}-${index.toString()}-${cellIndex.toString()}`}
                      colSpan={span === 1 ? undefined : span}
                      className={
                        Cell === "th"
                          ? `${tableCell} ${bodyText} font-semibold`
                          : `${tableCell} ${bodyText}`
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

    // A picture (FF-1625) is quotes-only, and a quote has no web view.
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
