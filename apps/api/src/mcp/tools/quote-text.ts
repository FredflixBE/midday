import { dropQuoteImages } from "@api/services/quote-images";
import { QuoteInputError } from "@midday/db/queries";
import {
  type Block,
  blockSchema,
  type EditorDoc,
  type QuoteContent,
} from "@midday/quote";
import { markdownToEditorDoc } from "@midday/ui/editor/markdown";
import { z } from "zod";
import { hasScope, type RegisterTools, WRITE_ANNOTATIONS } from "../types";
import { withErrorHandling } from "../utils";
import { editDraft } from "./quote-drafts";
import { blockDetail, quoteIdInput } from "./quotes";

/**
 * A quote's text through the MCP (FF-1791). The text is a list of blocks: a
 * text block holds a heading and a document the editor wrote, and two others
 * only mark a place — where the scenarios are priced, and where the list of
 * sections goes.
 *
 * The assistant reads and writes a text block's body as markdown, converted
 * to and from the editor's own schema, so what it writes is what the editor
 * would have saved. A body markdown cannot say whole — a picture, a diagram,
 * a merged cell — is shown, but not rewritten: writing its markdown back
 * would save the text without what the markdown left out.
 */

type NewId = () => string;
const newId: NewId = () => crypto.randomUUID();

function blockIn(content: QuoteContent, blockId: string) {
  const block = content.blocks.find((b) => b.id === blockId);
  if (!block) throw new QuoteInputError(`This draft has no block ${blockId}`);
  return block;
}

function placed(blocks: Block[], block: Block, index: number | undefined) {
  const others = blocks.filter((b) => b.id !== block.id);
  const at =
    index !== undefined
      ? Math.min(Math.max(index, 0), others.length)
      : blocks.some((b) => b.id === block.id)
        ? blocks.findIndex((b) => b.id === block.id)
        : others.length;
  others.splice(at, 0, block);
  return others;
}

export type TextBlockInput = {
  blockId?: string;
  heading?: string | null;
  markdown?: string;
  index?: number;
};

/**
 * A text block added, or one of the draft's changed, and placed at `index`
 * when one is given. A new block goes last.
 */
export function upsertTextBlock(
  content: QuoteContent,
  input: TextBlockInput,
  makeId: NewId = newId,
): { content: QuoteContent; blockId: string } {
  let block: Extract<Block, { type: "text" }>;

  if (input.blockId) {
    const found = blockIn(content, input.blockId);
    if (found.type !== "text") {
      throw new QuoteInputError(
        `Block ${input.blockId} marks where the ${found.type} goes; it can be moved, not written`,
      );
    }
    if (input.markdown !== undefined && !blockDetail(found).editable) {
      throw new QuoteInputError(
        "This block holds what markdown cannot say, such as a picture or a diagram; change its text in Midday",
      );
    }
    block = found;
  } else {
    block = {
      id: makeId(),
      type: "text",
      heading: null,
      body: markdownToEditorDoc("") as EditorDoc,
    };
  }

  if (input.heading !== undefined) block = { ...block, heading: input.heading };
  if (input.markdown !== undefined) {
    block = {
      ...block,
      body: markdownToEditorDoc(input.markdown) as EditorDoc,
    };
  }

  return {
    content: { ...content, blocks: placed(content.blocks, block, input.index) },
    blockId: block.id,
  };
}

/** Any block moved to `index`, the markers included. */
export function moveBlock(
  content: QuoteContent,
  blockId: string,
  index: number,
): QuoteContent {
  const block = blockIn(content, blockId);
  return { ...content, blocks: placed(content.blocks, block, index) };
}

/** A text block taken out; the places the markers hold stay. */
export function removeTextBlock(
  content: QuoteContent,
  blockId: string,
): QuoteContent {
  const block = blockIn(content, blockId);
  if (block.type !== "text") {
    throw new QuoteInputError(
      `Block ${blockId} marks where the ${block.type} goes; it can be moved, not removed`,
    );
  }
  return {
    ...content,
    blocks: content.blocks.filter((b) => b.id !== blockId),
  };
}

const textBlock = blockSchema.options[0].shape;

export const registerQuoteTextTools: RegisterTools = (server, ctx) => {
  if (!hasScope(ctx, "invoices.write")) return;

  // A picture that leaves the text with its block leaves storage too, once
  // nothing else names it — as when a block is removed in Midday (FF-1626).
  const dropImages = dropQuoteImages(ctx.teamId);

  server.registerTool(
    "quotes_upsert_text_block",
    {
      title: "Add or Change a Quote Text Block",
      description:
        "Add a text block to a quote's draft (leave blockId out), or change one (give its id from quotes_get). The body is markdown: headings, paragraphs, **bold**, *italic*, ~~strike~~, <u>underline</u>, `code`, links, bullet and numbered lists, block quotes, code blocks, rules and GitHub tables (column alignment with :---:). Pictures and other HTML are refused; add pictures in Midday. The quote's PDF does not print block quotes, code blocks or rules yet, so write what the client must read as paragraphs, lists or tables. A block quotes_get marks as not editable holds what markdown cannot say, so its body cannot be replaced here, only its heading. Only what is given changes; index moves the block to that position, counted from 0. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId: quoteIdInput,
        blockId: z
          .string()
          .optional()
          .describe("The text block to change; leave out to add one"),
        heading: textBlock.heading
          .optional()
          .describe("The block's heading; null for none"),
        markdown: z
          .string()
          .max(100_000)
          .optional()
          .describe("The block's body, in markdown; replaces the body whole"),
        index: z.number().int().min(0).optional(),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, ...input }) =>
        editDraft(ctx, quoteId, () => ({
          edit: (content) => upsertTextBlock(content, input).content,
          dropImages,
        })),
      "Failed to change the text block",
    ),
  );

  server.registerTool(
    "quotes_move_block",
    {
      title: "Move a Quote Block",
      description:
        "Move a block of a quote's draft to another position, counted from 0: a text block, or the pricing or contents block, which mark where the scenarios and the list of sections appear. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId: quoteIdInput,
        blockId: z.string(),
        index: z.number().int().min(0),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, blockId, index }) =>
        editDraft(ctx, quoteId, () => ({
          edit: (content) => moveBlock(content, blockId, index),
        })),
      "Failed to move the block",
    ),
  );

  server.registerTool(
    "quotes_remove_text_block",
    {
      title: "Remove a Quote Text Block",
      description:
        "Remove a text block, heading and body, from a quote's draft. The pricing and contents blocks are moved, not removed. Returns the quote as quotes_get does.",
      inputSchema: { quoteId: quoteIdInput, blockId: z.string() },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, blockId }) =>
        editDraft(ctx, quoteId, () => ({
          edit: (content) => removeTextBlock(content, blockId),
          dropImages,
        })),
      "Failed to remove the text block",
    ),
  );
};
