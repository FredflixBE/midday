import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import type { EditorDoc } from "../../types";
import { formatEditorContent } from "./format";

type Element = {
  type: string;
  key: string | null;
  props: Record<string, unknown>;
  children: (Element | string)[];
};

// The elements the card is drawn from. It is not rendered to markup: what
// draws it reads React elements, the `tw` prop and a narrow slice of CSS.
function tree(node: ReactNode): (Element | string)[] {
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

function elements(nodes: (Element | string)[]): Element[] {
  return nodes.flatMap((n) =>
    typeof n === "string" ? [] : [n, ...elements(n.children)],
  );
}

function textOf(node: Element | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({
  type: "paragraph",
  content: [text(value)],
});
const item = (...content: object[]) => ({ type: "listItem", content });

// What the from and customer blocks hold today: paragraphs with inline
// marks and a blank line between them.
const addressOnly: EditorDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Acme BV", marks: [{ type: "bold" }] }],
    },
    { type: "paragraph" },
    paragraph("Main street 1"),
  ],
} as EditorDoc;

function styleOf(element: Element): Record<string, unknown> {
  return (element.props.style as Record<string, unknown>) ?? {};
}

function spanHolding(doc: EditorDoc, value: string): Element {
  const found = elements(tree(formatEditorContent(doc))).find(
    (e) => e.type === "span" && e.children.includes(value),
  );
  if (!found) {
    throw new Error(`No span holding ${value}`);
  }
  return found;
}

describe("formatEditorContent", () => {
  test("keeps the words of a heading and a list, which used to be dropped", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Scope")] },
        {
          type: "bulletList",
          content: [
            item(paragraph("Design")),
            item(paragraph("Build"), {
              type: "bulletList",
              content: [item(paragraph("Frontend"))],
            }),
          ],
        },
        {
          type: "orderedList",
          content: [item(paragraph("Access"))],
        },
      ],
    } as EditorDoc;

    const lines = elements(tree(formatEditorContent(doc)))
      .filter((e) => e.type === "p")
      .map(textOf);

    expect(lines).toEqual(["Scope", "Design", "Build", "Frontend", "Access"]);
  });

  test("underlines and strikes the marks it never read", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { ...text("under"), marks: [{ type: "underline" }] },
            { ...text("gone"), marks: [{ type: "strike" }] },
            {
              ...text("both"),
              marks: [{ type: "underline" }, { type: "strike" }],
            },
            {
              ...text("linked"),
              marks: [{ type: "link", attrs: { href: "https://x.test" } }],
            },
          ],
        },
      ],
    } as EditorDoc;

    expect(styleOf(spanHolding(doc, "under")).textDecoration).toBe("underline");
    expect(styleOf(spanHolding(doc, "gone")).textDecoration).toBe(
      "line-through",
    );
    expect(styleOf(spanHolding(doc, "both")).textDecoration).toBe(
      "underline line-through",
    );
    expect(styleOf(spanHolding(doc, "linked")).textDecoration).toBe(
      "underline",
    );
  });

  test("leaves the decoration off entirely when there is none", () => {
    // An explicit undefined is not the same as absent here: what draws the
    // card trims whatever value it is handed, and throws on undefined.
    const style = styleOf(spanHolding(addressOnly, "Main street 1"));

    expect("textDecoration" in style).toBe(false);
  });

  // Down to the blank line between the two: the card an address-only
  // invoice draws is unchanged, byte for byte.
  test("renders an address exactly as before", () => {
    expect(tree(formatEditorContent(addressOnly))).toMatchSnapshot();
  });
});
