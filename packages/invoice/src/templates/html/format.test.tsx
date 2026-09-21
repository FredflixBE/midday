import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EditorDoc } from "../../types";
import { formatEditorContent } from "./format";

// The markup the web invoice view and the portal serve.
const html = (doc: EditorDoc) =>
  renderToStaticMarkup(<>{formatEditorContent(doc)}</>);

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({
  type: "paragraph",
  content: [text(value)],
});
const item = (...content: object[]) => ({ type: "listItem", content });

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

// The pixel size Tailwind's `text-[13px]` asks for, on the element holding
// `value`. Tailwind's reset flattens headings, so a heading that carries no
// size of its own reads as body text.
function fontSizeOf(markup: string, value: string) {
  const tag = markup.match(
    new RegExp(`<(\\w+)[^>]*class="([^"]*)"[^>]*>(?:<[^>]+>)*${value}`),
  );
  if (!tag) {
    throw new Error(`No element holding ${value} in ${markup}`);
  }
  const size = tag[2]?.match(/text-\[(\d+)px\]/);
  if (!size) {
    throw new Error(`No font size on ${value}: ${tag[2]}`);
  }
  return Number(size[1]);
}

describe("formatEditorContent", () => {
  test("renders a heading as a heading element, by level", () => {
    const markup = html(proposal);

    expect(markup).toContain("Proposal</span></h1>");
    expect(markup).toContain("Scope</span></h2>");
    expect(markup).toContain("Assumptions</span></h3>");
  });

  test("renders headings larger and bolder than body text, by level", () => {
    const markup = html(proposal);

    expect(fontSizeOf(markup, "Proposal")).toBeGreaterThan(
      fontSizeOf(markup, "Scope"),
    );
    expect(fontSizeOf(markup, "Scope")).toBeGreaterThan(
      fontSizeOf(markup, "Assumptions"),
    );
    expect(fontSizeOf(markup, "Assumptions")).toBeGreaterThan(
      fontSizeOf(markup, "What we will build."),
    );
    expect(markup).toMatch(/<h2 class="[^"]*font-semibold/);
  });

  test("keeps marks inside a heading", () => {
    const markup = html({
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
    } as EditorDoc);

    expect(markup).toMatch(/class="[^"]*italic[^"]*">slanted/);
    expect(fontSizeOf(markup, "slanted")).toBeGreaterThan(11);
  });

  test("renders a bullet list as a bulleted list, an item per entry", () => {
    const markup = html(proposal);

    expect(markup).toMatch(/<ul class="[^"]*list-disc/);
    expect(markup.match(/<li/g)).toHaveLength(7);
    expect(markup).toContain("Design");
    expect(markup).toContain("Build");
  });

  test("renders an ordered list as a numbered list, from its start", () => {
    const markup = html(proposal);

    expect(markup).toMatch(/<ol class="[^"]*list-decimal/);
    // A list starting at 1 needs no attribute; one starting later does.
    expect(markup).toMatch(/<ol [^>]*start="4"/);
    expect(markup.match(/start="1"/)).toBeNull();
  });

  test("nests a list inside the item it belongs to", () => {
    const markup = html(proposal);
    const build = markup.slice(markup.indexOf("Build"));

    // The nested list opens before the item holding it closes.
    expect(build.indexOf("<ul")).toBeLessThan(build.indexOf("</li>"));
    expect(build).toContain("Frontend");
  });

  test("underlines text carrying the underline mark", () => {
    const markup = html({
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
    } as EditorDoc);

    expect(markup).toMatch(/class="[^"]*\bunderline\b[^"]*">under</);
    // Tailwind's `underline` and `line-through` set the same property, so
    // text carrying both marks needs the pair written out.
    expect(markup).toMatch(/class="[^"]*underline_line-through[^"]*">both</);
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
          ],
        },
      ],
    } as EditorDoc;

    test("renders a table as a table, a row per row and a cell per cell", () => {
      const markup = html(comparison);

      expect(markup).toContain("<table");
      expect(markup.match(/<tr/g)).toHaveLength(2);
      expect(markup.match(/<th/g)).toHaveLength(3);
      expect(markup.match(/<td/g)).toHaveLength(3);
      expect(markup).toContain("Compleet");
      expect(markup).toContain("Pages");
    });

    test("gives every column the same share of the text column", () => {
      const markup = html(comparison);

      // `table-fixed` with a full width is what makes the columns equal;
      // without it the browser would size them by what they hold and the
      // page would disagree with the PDF.
      expect(markup).toMatch(/<table class="[^"]*table-fixed/);
      expect(markup).toMatch(/<table class="[^"]*w-full/);
    });

    test("gives a cell spanning two columns two columns' room", () => {
      const markup = html({
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              row({ ...cell("Both"), attrs: { colspan: 2 } }, cell("One")),
            ],
          },
        ],
      } as EditorDoc);

      expect(markup).toMatch(/<td [^>]*colspan="2"/i);
    });

    test("rules every cell on all sides and sets the header row apart", () => {
      const markup = html(comparison);

      // A line on every edge, so a column shows as well as a row.
      expect(markup).toMatch(/<th class="[^"]*\bborder\b/);
      expect(markup).toMatch(/<td class="[^"]*\bborder\b/);
      expect(markup).toMatch(/<th class="[^"]*font-semibold/);
      expect(markup).not.toMatch(/<td class="[^"]*font-semibold/);
    });

    test("draws a list written inside a cell as a list", () => {
      const markup = html({
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
      } as EditorDoc);

      expect(markup).toMatch(/<td[^>]*><ul class="[^"]*list-disc/);
      expect(markup).toContain("One");
    });

    test("leaves out a table with no rows rather than an empty box", () => {
      const markup = html({
        type: "doc",
        content: [{ type: "table", content: [] }, paragraph("After")],
      } as EditorDoc);

      expect(markup).not.toContain("<table");
      expect(markup).toContain("After");
    });
  });

  test("skips nodes it does not know instead of failing", () => {
    const markup = html({
      type: "doc",
      content: [{ type: "horizontalRule" }, paragraph("After")],
    } as EditorDoc);

    expect(markup).toContain("After");
    expect(markup).not.toContain("horizontalRule");
  });

  test("renders paragraph-only content exactly as before", () => {
    expect(html(paragraphsOnly)).toMatchSnapshot();
  });
});
