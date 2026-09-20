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

type Element = Exclude<Tree, string>;

function elements(trees: Tree[]): Element[] {
  return trees.flatMap((t) =>
    typeof t === "string" ? [] : [t, ...elements(t.children)],
  );
}

function textOf(t: Tree): string {
  return typeof t === "string" ? t : t.children.map(textOf).join("");
}

function styleOf(t: Element): Record<string, unknown> {
  return (t.props as { style?: Record<string, unknown> }).style ?? {};
}

// A row is an element whose direct children are a marker and a body.
function rows(trees: Tree[]) {
  return elements(trees)
    .filter((e) => styleOf(e).flexDirection === "row")
    .map((row) => {
      const [marker, body] = row.children as Element[];
      return { row, marker: textOf(marker!), body: body! };
    });
}

// Horizontal offset of the element holding `text`, summed down the tree.
function indentOf(trees: Tree[], text: string): number {
  function walk(t: Tree, offset: number): number | null {
    if (typeof t === "string") return null;
    const style = styleOf(t);
    const here =
      offset + Number(style.paddingLeft ?? 0) + Number(style.marginLeft ?? 0);
    if (t.children.some((c) => c === text)) return here;
    let sibling = 0;
    for (const child of t.children) {
      const found = walk(child, here + sibling);
      if (found !== null) return found;
      // Content after a marker cell sits to the right of it.
      if (typeof child !== "string" && styleOf(t).flexDirection === "row") {
        sibling += Number(styleOf(child).width ?? 0);
      }
    }
    return null;
  }
  for (const t of trees) {
    const found = walk(t, 0);
    if (found !== null) return found;
  }
  throw new Error(`No text ${text}`);
}

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({
  type: "paragraph",
  content: [text(value)],
});
const item = (...content: object[]) => ({ type: "listItem", content });

const proposal = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("Proposal")] },
    { type: "heading", attrs: { level: 2 }, content: [text("Scope")] },
    paragraph("What we will build."),
    {
      type: "bulletList",
      content: [
        item(paragraph("Design")),
        item(paragraph("Build"), {
          type: "bulletList",
          content: [item(paragraph("Frontend")), item(paragraph("Backend"))],
        }),
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [text("Assumptions")] },
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [item(paragraph("Access")), item(paragraph("Content"))],
    },
    {
      type: "orderedList",
      attrs: { start: 4 },
      content: [item(paragraph("Continued"))],
    },
  ],
} as EditorDoc;

describe("formatEditorContent", () => {
  test("renders headings larger and bolder than body text, by level", () => {
    const out = elements(tree(formatEditorContent(proposal)));
    const sizeOf = (value: string) =>
      Number(styleOf(out.find((e) => e.children.includes(value))!).fontSize);
    const weightOf = (value: string) =>
      Number(styleOf(out.find((e) => e.children.includes(value))!).fontWeight);

    expect(sizeOf("Proposal")).toBeGreaterThan(sizeOf("Scope"));
    expect(sizeOf("Scope")).toBeGreaterThan(sizeOf("Assumptions"));
    expect(sizeOf("Assumptions")).toBeGreaterThan(
      sizeOf("What we will build."),
    );
    expect(weightOf("Scope")).toBeGreaterThanOrEqual(600);
  });

  test("keeps marks inside a heading", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            text("Plain "),
            { ...text("slanted"), marks: [{ type: "italic" }] },
          ],
        },
      ],
    } as EditorDoc;
    const out = elements(tree(formatEditorContent(doc)));
    const slanted = out.find((e) => e.children.includes("slanted"))!;
    expect(styleOf(slanted).fontStyle).toBe("italic");
    expect(Number(styleOf(slanted).fontSize)).toBeGreaterThan(9);
  });

  test("puts a bullet before each bullet list item", () => {
    const listed = rows(tree(formatEditorContent(proposal)));
    const bullets = listed.filter((r) => r.marker === "•");
    expect(bullets.map((r) => textOf(r.body.children[0]!))).toEqual([
      "Design",
      "Build",
      "Frontend",
      "Backend",
    ]);
  });

  test("numbers ordered list items from the list's start", () => {
    const listed = rows(tree(formatEditorContent(proposal)));
    const numbered = listed
      .filter((r) => r.marker !== "•")
      .map((r) => [r.marker, textOf(r.body)]);
    expect(numbered).toEqual([
      ["1.", "Access"],
      ["2.", "Content"],
      ["4.", "Continued"],
    ]);
  });

  test("widens the number cell for two-digit numbers, alike for every item", () => {
    const long = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 9 },
          content: [item(paragraph("Nine")), item(paragraph("Ten"))],
        },
      ],
    } as EditorDoc;
    const widths = (doc: EditorDoc) =>
      rows(tree(formatEditorContent(doc))).map((r) =>
        Number(styleOf(r.row.children[0] as Element).width),
      );
    const [nine, ten] = widths(long);
    expect(nine).toBe(ten);
    expect(ten).toBeGreaterThan(widths(proposal).at(-1)!);
  });

  test("nests a list inside its item, further indented", () => {
    const out = tree(formatEditorContent(proposal));
    const build = rows(out).find(
      (r) => r.marker === "•" && textOf(r.body).startsWith("Build"),
    )!;
    expect(textOf(build.body)).toBe("Build•Frontend•Backend");
    expect(indentOf(out, "Frontend")).toBeGreaterThan(indentOf(out, "Build"));
    expect(indentOf(out, "Build")).toBeGreaterThan(
      indentOf(out, "What we will build."),
    );
  });

  test("underlines text carrying the underline mark", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { ...text("under"), marks: [{ type: "underline" }] },
            {
              ...text("both"),
              marks: [{ type: "underline" }, { type: "strike" }],
            },
          ],
        },
      ],
    } as EditorDoc;
    const out = elements(tree(formatEditorContent(doc)));
    const decorationOf = (value: string) =>
      styleOf(out.find((e) => e.children.includes(value))!).textDecoration;

    expect(decorationOf("under")).toBe("underline");
    expect(decorationOf("both")).toBe("underline line-through");
  });

  describe("a picture", () => {
    const withImage = {
      type: "doc",
      content: [
        paragraph("Before"),
        { type: "image", attrs: { path: "team/quotes/a.png", alt: "Chart" } },
        paragraph("After"),
      ],
    } as EditorDoc;
    const bytes = Buffer.from([1, 2, 3]);
    const imageOf = () => ({ data: bytes, format: "png" as const });

    test("is drawn at the width of the text column, whole", () => {
      const out = elements(tree(formatEditorContent(withImage, { imageOf })));
      const image = out.find((e) => e.type === "IMAGE")!;

      expect((image.props as { src: unknown }).src).toEqual({
        data: bytes,
        format: "png",
      });
      expect(styleOf(image).width).toBe("100%");
      // Its own proportions: nothing fixes the height, and a tall one is
      // fitted inside the room a page has rather than running off it.
      expect(styleOf(image).height).toBeUndefined();
      expect(Number(styleOf(image).maxHeight)).toBeGreaterThan(0);
      expect(Number(styleOf(image).maxHeight)).toBeLessThan(700);
      expect(styleOf(image).objectFit).toBe("contain");

      const holder = out.find((e) => e.children.includes(image))!;
      expect((holder.props as { wrap?: boolean }).wrap).toBe(false);
    });

    test("is passed over when its bytes cannot be had", () => {
      const out = tree(formatEditorContent(withImage, { imageOf: () => null }));
      expect(elements(out).some((e) => e.type === "IMAGE")).toBe(false);
      expect(textOf({ type: "x", key: null, props: {}, children: out })).toBe(
        "BeforeAfter",
      );
    });

    test("is passed over when nothing knows how to read a path", () => {
      const out = elements(tree(formatEditorContent(withImage)));
      expect(out.some((e) => e.type === "IMAGE")).toBe(false);
    });

    test("is found inside a list item too", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              item(paragraph("With"), {
                type: "image",
                attrs: { path: "team/quotes/b.png" },
              }),
            ],
          },
        ],
      } as EditorDoc;
      const out = elements(tree(formatEditorContent(doc, { imageOf })));
      expect(out.filter((e) => e.type === "IMAGE")).toHaveLength(1);
    });
  });

  describe("a table", () => {
    const cell = (value: string) => ({
      type: "tableCell",
      content: [paragraph(value)],
    });
    const header = (value: string) => ({
      type: "tableHeader",
      content: [paragraph(value)],
    });
    const row = (...content: object[]) => ({ type: "tableRow", content });

    const comparison = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            row(header("Feature"), header("Basis"), header("Compleet")),
            row(cell("Pages"), cell("5"), cell("20")),
            row(cell("Support"), cell("Email"), cell("Phone")),
          ],
        },
      ],
    } as EditorDoc;

    // The table itself: the outermost element holding the rows.
    function tableOf(doc: EditorDoc) {
      const out = elements(tree(formatEditorContent(doc)));
      const rowsOf = (e: Element) =>
        e.children.filter(
          (c): c is Element =>
            typeof c !== "string" && styleOf(c).flexDirection === "row",
        );
      return out.find((e) => rowsOf(e).length > 0)!;
    }

    test("draws the cells row by row, in the order they were written", () => {
      const table = tableOf(comparison);
      expect(table.children.map(textOf)).toEqual([
        "FeatureBasisCompleet",
        "Pages520",
        "SupportEmailPhone",
      ]);
    });

    test("gives every column the same share of the text column", () => {
      const table = tableOf(comparison);
      expect(styleOf(table).width).toBe("100%");
      for (const line of table.children as Element[]) {
        const widths = (line.children as Element[]).map(
          (c) => styleOf(c).flexGrow ?? styleOf(c).flex,
        );
        expect(widths).toEqual([1, 1, 1]);
        // Nothing fixes a column, so three columns are three equal thirds
        // whatever the text column happens to be.
        for (const c of line.children as Element[]) {
          expect(styleOf(c).width).toBeUndefined();
        }
      }
    });

    test("gives a cell spanning two columns two columns' room", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              row({ ...cell("Both"), attrs: { colspan: 2 } }, cell("One")),
            ],
          },
        ],
      } as EditorDoc;
      const line = tableOf(doc).children[0] as Element;
      expect(
        (line.children as Element[]).map((c) => styleOf(c).flexGrow),
      ).toEqual([2, 1]);
    });

    test("keeps a row whole but lets a long table break between rows", () => {
      const table = tableOf(comparison);
      expect((table.props as { wrap?: boolean }).wrap).not.toBe(false);
      for (const line of table.children as Element[]) {
        expect((line.props as { wrap?: boolean }).wrap).toBe(false);
      }
    });

    test("sets the header row apart from the rows under it", () => {
      const out = elements(tree(formatEditorContent(comparison)));
      const weightOf = (value: string) =>
        Number(
          styleOf(out.find((e) => e.children.includes(value))!).fontWeight,
        );

      expect(weightOf("Feature")).toBeGreaterThanOrEqual(600);
      expect(weightOf("Pages")).not.toBeGreaterThanOrEqual(600);
    });

    test("rules every row off so the grid reads as a grid", () => {
      const table = tableOf(comparison);
      for (const line of table.children as Element[]) {
        expect(Number(styleOf(line).borderBottomWidth)).toBeGreaterThan(0);
      }
    });

    test("draws a list written inside a cell as a list", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              row({
                type: "tableCell",
                content: [
                  {
                    type: "bulletList",
                    content: [item(paragraph("One")), item(paragraph("Two"))],
                  },
                ],
              }),
            ],
          },
        ],
      } as EditorDoc;
      const listed = rows(tree(formatEditorContent(doc))).filter(
        (r) => r.marker === "\u2022",
      );
      expect(listed.map((r) => textOf(r.body))).toEqual(["One", "Two"]);
    });

    test("draws an empty cell as an empty cell, not as nothing", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "table",
            content: [row(cell("Filled"), { type: "tableCell" })],
          },
        ],
      } as EditorDoc;
      const line = tableOf(doc).children[0] as Element;
      expect(line.children).toHaveLength(2);
      expect(textOf(line)).toBe("Filled");
    });

    test("leaves out a table with no rows rather than drawing an empty box", () => {
      const doc = {
        type: "doc",
        content: [{ type: "table", content: [] }, paragraph("After")],
      } as EditorDoc;
      const out = tree(formatEditorContent(doc));
      expect(textOf({ type: "x", key: null, props: {}, children: out })).toBe(
        "After",
      );
    });
  });

  test("skips nodes it does not know instead of failing", () => {
    const doc = {
      type: "doc",
      content: [{ type: "horizontalRule" }, paragraph("After")],
    } as EditorDoc;
    expect(
      textOf({
        type: "x",
        key: null,
        props: {},
        children: tree(formatEditorContent(doc)),
      }),
    ).toBe("After");
  });

  test("renders paragraph-only content exactly as before", () => {
    expect(tree(formatEditorContent(paragraphsOnly))).toMatchSnapshot();
  });
});
