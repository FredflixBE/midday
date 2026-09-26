import { describe, expect, test } from "bun:test";
import type { JSONContent } from "@tiptap/core";
import { editorSchema } from "./extentions/schema";
import {
  editorDocToMarkdown,
  MarkdownInputError,
  markdownToEditorDoc,
} from "./markdown";

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  content,
});
const cell = (
  type: "tableHeader" | "tableCell",
  value: string,
  align: string | null = null,
): JSONContent => ({
  type,
  attrs: { align },
  content: [paragraph(text(value))],
});

/** Everything the editor holds that markdown can say, as the editor saves it. */
const everything: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("Proposal")] },
    { type: "heading", attrs: { level: 3 }, content: [text("Scope")] },
    paragraph(
      text("Plain, "),
      text("bold", [{ type: "bold" }]),
      text(", "),
      text("italic", [{ type: "italic" }]),
      text(", "),
      text("underlined", [{ type: "underline" }]),
      text(", "),
      text("struck", [{ type: "strike" }]),
      text(", "),
      text("code", [{ type: "code" }]),
      text(" and "),
      text("a link", [
        {
          type: "link",
          attrs: {
            href: "https://example.com/terms",
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        },
      ]),
      text(". Stars * and _underscores_ stay text."),
    ),
    paragraph(text("One line"), { type: "hardBreak" }, text("and the next")),
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [paragraph(text("First"))] },
        {
          type: "listItem",
          content: [
            paragraph(text("Second")),
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [paragraph(text("Nested"))] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        { type: "listItem", content: [paragraph(text("Third"))] },
        { type: "listItem", content: [paragraph(text("Fourth"))] },
      ],
    },
    { type: "blockquote", content: [paragraph(text("Quoted"))] },
    {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [text("const a = 1;\nconst b = `x`;")],
    },
    { type: "horizontalRule" },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            cell("tableHeader", "Phase"),
            cell("tableHeader", "Who", "center"),
            cell("tableHeader", "Days", "right"),
          ],
        },
        {
          type: "tableRow",
          content: [
            cell("tableCell", "Design | build"),
            cell("tableCell", "Us", "center"),
            cell("tableCell", "4", "right"),
          ],
        },
      ],
    },
    paragraph(text("After the table")),
  ],
};

/** As the editor would save it: every attr the schema fills in, filled in. */
const saved = (doc: JSONContent) => editorSchema.nodeFromJSON(doc).toJSON();

describe("a document the editor saved", () => {
  test("reads as markdown and writes back as the very same document", () => {
    const { markdown, exact } = editorDocToMarkdown(everything);

    expect(exact).toBe(true);
    expect(markdownToEditorDoc(markdown)).toEqual(saved(everything));
  });

  test("reads as the markdown a person would write", () => {
    const { markdown } = editorDocToMarkdown(everything);

    expect(markdown).toContain("# Proposal\n\n### Scope");
    expect(markdown).toContain(
      "**bold**, *italic*, <u>underlined</u>, ~~struck~~, `code` and [a link](https://example.com/terms)",
    );
    expect(markdown).toContain("- First\n- Second\n  - Nested");
    expect(markdown).toContain("3. Third\n4. Fourth");
    expect(markdown).toContain("```ts\nconst a = 1;");
    expect(markdown).toContain(
      "| Phase | Who | Days |\n| --- | :---: | ---: |\n| Design \\| build | Us | 4 |",
    );
  });

  test("that is only paragraphs, saved without attrs, is exact too", () => {
    const plain = { type: "doc", content: [paragraph(text("Hello"))] };
    expect(editorDocToMarkdown(plain)).toEqual({
      markdown: "Hello",
      exact: true,
    });
  });

  test("with a picture or a diagram reads whole, but cannot come back", () => {
    const withPicture = {
      type: "doc",
      content: [
        paragraph(text("See below")),
        { type: "image", attrs: { path: "team/quotes/a.png", alt: null } },
        {
          type: "diagram",
          attrs: {
            source: "flowchart LR\n A --> B",
            path: "team/quotes/d.png",
          },
        },
      ],
    };
    const { markdown, exact } = editorDocToMarkdown(withPicture);
    expect(exact).toBe(false);
    expect(markdown).toContain("![](team/quotes/a.png)");
    expect(markdown).toContain("```mermaid\nflowchart LR\n A --> B\n```");
  });

  test("with what markdown cannot say, a merged cell, cannot come back", () => {
    const merged = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { ...cell("tableHeader", "Wide"), attrs: { colspan: 2 } },
              ],
            },
          ],
        },
      ],
    };
    expect(editorDocToMarkdown(merged).exact).toBe(false);
  });
});

describe("markdown written by the assistant", () => {
  test("becomes the document the editor would save for it", () => {
    const doc = markdownToEditorDoc(
      [
        "## Approach",
        "",
        "We work in **two** phases:",
        "",
        "1. Discovery",
        "2. Build",
        "",
        "| Phase | Weeks |",
        "| :--- | ---: |",
        "| Discovery | 2 |",
      ].join("\n"),
    );

    expect(doc).toEqual(
      saved({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [text("Approach")] },
          paragraph(
            text("We work in "),
            text("two", [{ type: "bold" }]),
            text(" phases:"),
          ),
          {
            type: "orderedList",
            content: [
              { type: "listItem", content: [paragraph(text("Discovery"))] },
              { type: "listItem", content: [paragraph(text("Build"))] },
            ],
          },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  cell("tableHeader", "Phase", "left"),
                  cell("tableHeader", "Weeks", "right"),
                ],
              },
              {
                type: "tableRow",
                content: [
                  cell("tableCell", "Discovery", "left"),
                  cell("tableCell", "2", "right"),
                ],
              },
            ],
          },
        ],
      }),
    );
  });

  test("a table inside a list or a quote keeps its place", () => {
    for (const markdown of [
      "- Phases\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |",
      "> | A | B |\n> | --- | --- |\n> | 1 | 2 |",
    ]) {
      const doc = markdownToEditorDoc(markdown);
      expect(editorDocToMarkdown(doc)).toEqual({ markdown, exact: true });
    }
  });

  // What the editor cannot nest would be saved as something else — an empty
  // line before the heading, the bold taken off the code — and the block
  // could then not be written again. Said now, it can be written simpler.
  test("that the editor cannot hold as written is refused, not saved as something else", () => {
    for (const markdown of ["- # Heading in a list", "**bold `code` bold**"]) {
      expect(() => markdownToEditorDoc(markdown)).toThrow(
        /write it more simply/,
      );
    }
  });

  test("with nothing in it is an empty paragraph, as an empty editor saves", () => {
    expect(markdownToEditorDoc("")).toEqual(
      saved({ type: "doc", content: [{ type: "paragraph" }] }),
    );
  });

  test("with a picture is refused, not saved without it", () => {
    expect(() =>
      markdownToEditorDoc("Look: ![chart](https://x.test/a.png)"),
    ).toThrow(MarkdownInputError);
    expect(() =>
      markdownToEditorDoc("Look: ![chart](https://x.test/a.png)"),
    ).toThrow(/picture/);
  });

  test("with HTML other than <u> is refused", () => {
    expect(() => markdownToEditorDoc("<div>block</div>")).toThrow(
      MarkdownInputError,
    );
    expect(() => markdownToEditorDoc("a <b>bold</b> word")).toThrow(
      /Only markdown/,
    );
    expect(markdownToEditorDoc("an <u>underlined</u> word")).toEqual(
      saved({
        type: "doc",
        content: [
          paragraph(
            text("an "),
            text("underlined", [{ type: "underline" }]),
            text(" word"),
          ),
        ],
      }),
    );
  });
});
