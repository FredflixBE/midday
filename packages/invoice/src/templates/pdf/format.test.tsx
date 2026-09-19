import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import type { EditorDoc } from "../../types";
import { formatEditorContent } from "./format";

type Tree =
  | string
  | { type: string; key: string | null; props: object; children: Tree[] };

// The rendered elements as plain data: react-pdf primitives are strings
// ("VIEW", "TEXT", "LINK"), so this is what reaches the PDF.
function tree(node: ReactNode): Tree[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (typeof node === "string" || typeof node === "number") {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(tree);
  }
  if (isValidElement(node)) {
    const { children, ...props } = node.props as {
      children?: ReactNode;
    } & Record<string, unknown>;
    if (typeof node.type === "symbol") {
      // A fragment.
      return tree(children);
    }
    return [
      {
        type: String(node.type),
        key: node.key,
        props,
        children: tree(children),
      },
    ];
  }
  throw new Error(`Unexpected node: ${String(node)}`);
}

// What an invoice block holds today: paragraphs with inline marks, links,
// an email address and a hard break.
const paragraphsOnly: EditorDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Acme BV", marks: [{ type: "bold" }] },
        { type: "hardBreak" },
        { type: "text", text: "Main street 1", marks: [{ type: "italic" }] },
        { type: "text", text: " old", marks: [{ type: "strike" }] },
      ],
    },
    { type: "paragraph" },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "example.com",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        },
        { type: "text", text: " " },
        { type: "text", text: "hello@example.com" },
      ],
    },
  ],
};

describe("formatEditorContent", () => {
  test("renders paragraph-only content exactly as before", () => {
    expect(tree(formatEditorContent(paragraphsOnly))).toMatchSnapshot();
  });
});
