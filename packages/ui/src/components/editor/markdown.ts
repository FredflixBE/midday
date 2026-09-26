import type { JSONContent } from "@tiptap/core";
import {
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "@tiptap/pm/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { editorSchema } from "./extentions/schema";

/**
 * The editor's documents as markdown and back (FF-1791), for an assistant
 * that reads and writes a quote's text through the MCP.
 *
 * Both directions go through `editorSchema`, the schema every editor is built
 * on, so a document written from markdown is the document the editor would
 * have saved for the same text: the same nodes, the same attrs, filled in the
 * same way. Everything the editor holds has a markdown form except pictures
 * and diagrams, which live in storage and are added in Midday itself:
 *
 * - headings, paragraphs, bold, italic, `code`, links, block quotes, code
 *   blocks, rules and hard breaks: CommonMark;
 * - bullet and numbered lists: CommonMark, written tight;
 * - strikethrough (`~~`) and tables: GitHub's markdown, a table's column
 *   alignment standing for its cells';
 * - underline, which markdown has none of: `<u>…</u>`, the only HTML taken.
 */

export class MarkdownInputError extends Error {}

const tokenizer = new MarkdownIt("commonmark", { html: true }).enable([
  "table",
  "strikethrough",
]);

const ALIGNS = ["left", "center", "right"] as const;
type Align = (typeof ALIGNS)[number] | null;

function alignOf(token: Token): Align {
  const style = token.attrGet("style") ?? "";
  return ALIGNS.find((align) => style.includes(`text-align:${align}`)) ?? null;
}

/** A token markdown-it does not make, for a node the schema needs. */
const made = (type: string, nesting: 1 | -1) =>
  ({ type, nesting, attrs: null, children: null }) as unknown as Token;

/**
 * markdown-it's tokens, shaped for the parser below: a table cell gets the
 * paragraph the schema puts in every cell, `<u>` becomes underline, and what
 * has no place in the text is refused rather than dropped.
 */
function shaped(tokens: Token[]): Token[] {
  return tokens.flatMap((token): Token[] => {
    if (token.children) token.children = shaped(token.children);
    switch (token.type) {
      case "th_open":
      case "td_open":
        return [token, made("paragraph_open", 1)];
      case "th_close":
      case "td_close":
        return [made("paragraph_close", -1), token];
      case "image":
        throw new MarkdownInputError(
          "A picture cannot be written in markdown; add it in Midday",
        );
      case "html_inline": {
        const tag = token.content.trim().toLowerCase();
        if (tag === "<u>" || tag === "</u>") {
          token.type = tag === "<u>" ? "u_open" : "u_close";
          return [token];
        }
        throw new MarkdownInputError(
          `Only markdown is taken, and <u> for underline: ${token.content}`,
        );
      }
      case "html_block":
        throw new MarkdownInputError(
          `Only markdown is taken, and <u> for underline: ${token.content.trim()}`,
        );
      default:
        return [token];
    }
  });
}

const parser = new MarkdownParser(
  editorSchema,
  {
    parse: (text: string, env: object) => shaped(tokenizer.parse(text, env)),
  } as unknown as MarkdownIt,
  {
    paragraph: { block: "paragraph" },
    heading: {
      block: "heading",
      getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }),
    },
    blockquote: { block: "blockquote" },
    bullet_list: { block: "bulletList" },
    ordered_list: {
      block: "orderedList",
      getAttrs: (token) => ({ start: Number(token.attrGet("start") ?? 1) }),
    },
    list_item: { block: "listItem" },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (token) => ({ language: token.info.trim() || null }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "tableRow" },
    th: {
      block: "tableHeader",
      getAttrs: (token) => ({ align: alignOf(token) }),
    },
    td: {
      block: "tableCell",
      getAttrs: (token) => ({ align: alignOf(token) }),
    },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    u: { mark: "underline" },
    code_inline: { mark: "code", noCloseToken: true },
    link: {
      mark: "link",
      getAttrs: (token) => ({ href: token.attrGet("href") }),
    },
  },
);

/** Every word the tokens hold, so a node the schema would not take shows. */
function wordsOf(tokens: Token[]): string {
  return tokens
    .map((token) =>
      token.children
        ? wordsOf(token.children)
        : ["text", "code_inline", "code_block", "fence"].includes(token.type)
          ? token.content
          : "",
    )
    .join("");
}

const withoutSpace = (text: string) => text.replace(/\s+/g, "");

const d = defaultMarkdownSerializer;

/** A table's cell as one line of inline markdown, its pipes escaped. */
function cellText(cell: ProseMirrorNode) {
  return serializer
    .serialize(cell, { tightLists: true })
    .trim()
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ");
}

const serializer: MarkdownSerializer = new MarkdownSerializer(
  {
    doc: (state, node) => state.renderContent(node),
    paragraph: d.nodes.paragraph!,
    heading: d.nodes.heading!,
    blockquote: d.nodes.blockquote!,
    horizontalRule: d.nodes.horizontal_rule!,
    listItem: d.nodes.list_item!,
    hardBreak: d.nodes.hard_break!,
    text: d.nodes.text!,
    bulletList: (state, node) => state.renderList(node, "  ", () => "- "),
    orderedList: (state, node) => {
      const start = (node.attrs.start as number | null) ?? 1;
      const width = String(start + node.childCount - 1).length;
      const space = " ".repeat(width + 2);
      state.renderList(node, space, (index) => {
        const number = String(start + index);
        return `${" ".repeat(width - number.length)}${number}. `;
      });
    },
    codeBlock: (state, node) => {
      const runs = node.textContent.match(/`{3,}/g) ?? [];
      const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      state.write(`${fence}${(node.attrs.language as string | null) ?? ""}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    table: (state, node) => {
      const rows: string[][] = [];
      const aligns: Align[] = [];
      node.forEach((row, _, rowIndex) => {
        const cells: string[] = [];
        row.forEach((cell) => {
          cells.push(cellText(cell));
          if (rowIndex === 0) aligns.push(cell.attrs.align as Align);
        });
        rows.push(cells);
      });
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const rule = aligns.map((align) =>
        align === "center"
          ? ":---:"
          : align === "right"
            ? "---:"
            : align === "left"
              ? ":---"
              : "---",
      );
      const [head = [], ...body] = rows;
      // A line at a time, so each takes the prefix of whatever holds the
      // table: a list item's indent, a quote's `>`.
      for (const cells of [head, rule, ...body]) {
        state.write(line(cells));
        state.ensureNewLine();
      }
      state.closeBlock(node);
    },
    // Neither has a markdown form that comes back as itself; both are
    // written so the text reads whole, and `exact` says it cannot return.
    image: (state, node) => {
      state.write(`![${node.attrs.alt ?? ""}](${node.attrs.path ?? ""})`);
      state.closeBlock(node);
    },
    diagram: (state, node) => {
      state.write(`\`\`\`mermaid\n${node.attrs.source as string}\n\`\`\``);
      state.closeBlock(node);
    },
  },
  {
    italic: d.marks.em!,
    bold: d.marks.strong!,
    code: d.marks.code!,
    link: d.marks.link!,
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    underline: {
      open: "<u>",
      close: "</u>",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

/**
 * A document the editor saved, as markdown. `exact` says whether writing that
 * markdown back gives this very document; when it does not — a picture, a
 * diagram, a merged cell, something markdown has no way to say — the
 * markdown only reads it, and writing it back would lose what it cannot say.
 */
export function editorDocToMarkdown(doc: JSONContent): {
  markdown: string;
  exact: boolean;
} {
  const node = editorSchema.nodeFromJSON(doc);
  const markdown = serializer
    .serialize(node, { tightLists: true })
    .replace(/\n+$/, "");

  let exact = false;
  try {
    exact = parser.parse(markdown).eq(node);
  } catch {
    exact = false;
  }
  return { markdown, exact };
}

/**
 * Markdown as the document the editor would save for it. Refuses, with a
 * `MarkdownInputError`, what it cannot hold — a picture, HTML other than
 * `<u>` — and any text the schema would not have taken, rather than saving
 * the document without it.
 */
export function markdownToEditorDoc(markdown: string): JSONContent {
  const doc = parser.parse(markdown);

  const given = withoutSpace(wordsOf(shaped(tokenizer.parse(markdown, {}))));
  let kept = "";
  doc.descendants((node) => {
    if (node.isText) kept += node.text;
  });
  if (withoutSpace(kept) !== given) {
    throw new MarkdownInputError(
      "Part of this markdown has no place in the text; write it more simply",
    );
  }

  // What the editor cannot nest as written — a heading or a table first in
  // a list item, code inside bold — is saved as something close to it, and
  // then reads back as markdown that is not the text. Refused here, so all
  // that is written can be read and written again.
  const json = doc.toJSON();
  if (!editorDocToMarkdown(json).exact) {
    throw new MarkdownInputError(
      "This markdown nests what the text cannot hold as written, such as a heading inside a list or code inside bold; write it more simply",
    );
  }
  return json;
}
