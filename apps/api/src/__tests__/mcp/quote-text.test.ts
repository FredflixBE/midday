import "../setup";
import { beforeEach, describe, expect, test } from "bun:test";
import { getQuote, updateQuoteDraft } from "@midday/db/queries";
import type { EditorDoc, QuoteContent } from "@midday/quote";
import { markdownToEditorDoc } from "@midday/ui/editor/markdown";
import { createMcpServer } from "../../mcp/server";
import {
  moveBlock,
  removeTextBlock,
  upsertTextBlock,
} from "../../mcp/tools/quote-text";
import { blockDetail } from "../../mcp/tools/quotes";
import type { McpContext } from "../../mcp/types";
import { asMock } from "../setup";

const body = (markdown: string) => markdownToEditorDoc(markdown) as EditorDoc;

const withPicture = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "See below" }] },
    { type: "image", attrs: { path: "team/quotes/a.png", alt: null } },
  ],
};

const content = (): QuoteContent => ({
  blocks: [
    {
      id: "intro",
      type: "text",
      heading: "Introduction",
      body: body("We propose **two** phases."),
    },
    { id: "pricing", type: "pricing" },
    { id: "photos", type: "text", heading: "Photos", body: withPicture },
  ],
  rates: { productRates: {}, volumeTiers: [], termTiers: [] },
  displayUnit: "hours",
  hoursPerDay: 8,
  scenarios: [],
});

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("a block, read", () => {
  test("gives a text block's body as markdown it can be written back from", () => {
    expect(blockDetail(content().blocks[0]!)).toEqual({
      id: "intro",
      type: "text",
      heading: "Introduction",
      markdown: "We propose **two** phases.",
      editable: true,
    });
  });

  test("gives a marker as where it is, and nothing else", () => {
    expect(blockDetail(content().blocks[1]!)).toEqual({
      id: "pricing",
      type: "pricing",
    });
  });

  test("with a picture reads whole, and says it cannot be written back", () => {
    expect(blockDetail(content().blocks[2]!)).toMatchObject({
      markdown: "See below\n\n![](team/quotes/a.png)",
      editable: false,
    });
  });

  test("saved with a node this build does not know is shown as unreadable, not thrown", () => {
    const unknown = {
      id: "x",
      type: "text" as const,
      heading: null,
      body: { type: "doc" as const, content: [{ type: "mystery" }] },
    };
    expect(blockDetail(unknown)).toMatchObject({
      markdown: null,
      editable: false,
    });
  });
});

describe("a text block, written", () => {
  test("added goes last, with a new id, its markdown saved as the editor would", () => {
    const { content: next, blockId } = upsertTextBlock(
      content(),
      { heading: "Approach", markdown: "- Discovery\n- Build" },
      ids(),
    );

    expect(blockId).toBe("new-1");
    expect(next.blocks.map((b) => b.id)).toEqual([
      "intro",
      "pricing",
      "photos",
      "new-1",
    ]);
    expect(next.blocks[3]).toEqual({
      id: "new-1",
      type: "text",
      heading: "Approach",
      body: body("- Discovery\n- Build"),
    });
  });

  test("changed keeps its place and every other block, or moves to the index given", () => {
    const { content: next } = upsertTextBlock(content(), {
      blockId: "intro",
      markdown: "We propose **three** phases.",
      index: 2,
    });

    expect(next.blocks.map((b) => b.id)).toEqual([
      "pricing",
      "photos",
      "intro",
    ]);
    expect(blockDetail(next.blocks[2]!)).toMatchObject({
      heading: "Introduction",
      markdown: "We propose **three** phases.",
    });
    expect(next.blocks[1]).toEqual(content().blocks[2]!);
  });

  test("holding a picture takes a new heading, but not a body that would lose it", () => {
    const { content: next } = upsertTextBlock(content(), {
      blockId: "photos",
      heading: "Site photos",
    });
    expect(next.blocks[2]).toMatchObject({
      heading: "Site photos",
      body: withPicture,
    });

    expect(() =>
      upsertTextBlock(content(), { blockId: "photos", markdown: "See below" }),
    ).toThrow(/change its text in Midday/);
  });

  test("a marker is not written, and a block that is not there is not added", () => {
    expect(() =>
      upsertTextBlock(content(), { blockId: "pricing", heading: "Prices" }),
    ).toThrow(/can be moved, not written/);
    expect(() =>
      upsertTextBlock(content(), { blockId: "gone", heading: "x" }),
    ).toThrow("This draft has no block gone");
  });

  test("markdown with a picture in it is refused", () => {
    expect(() =>
      upsertTextBlock(content(), { markdown: "![plan](https://x.test/p.png)" }),
    ).toThrow(/picture/);
  });
});

describe("the blocks", () => {
  test("any of them moves, the markers included", () => {
    expect(moveBlock(content(), "pricing", 0).blocks.map((b) => b.id)).toEqual([
      "pricing",
      "intro",
      "photos",
    ]);
  });

  test("a text block is removed; a marker is not", () => {
    expect(removeTextBlock(content(), "intro").blocks.map((b) => b.id)).toEqual(
      ["pricing", "photos"],
    );
    expect(() => removeTextBlock(content(), "pricing")).toThrow(
      /moved, not removed/,
    );
  });
});

const Q = "a1b2c3d4-0000-4000-8000-000000000001";

function tools() {
  const s = createMcpServer({
    db: {} as McpContext["db"],
    teamId: "test-team-id",
    userId: "test-user-id",
    userEmail: "test@example.com",
    scopes: ["invoices.read", "invoices.write"],
    apiUrl: "https://api.example.test",
    timezone: "UTC",
    locale: "en",
    countryCode: "BE",
    dateFormat: null,
    timeFormat: 24,
  });
  return (
    s as unknown as {
      _registeredTools: Record<
        string,
        {
          inputSchema: { parse: (args: unknown) => unknown };
          handler: (args: unknown, extra: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools;
}

async function call(name: string, args: Record<string, unknown>) {
  const tool = tools()[name]!;
  return tool.handler(tool.inputSchema.parse(args), {});
}

describe("the text tools", () => {
  beforeEach(() => {
    asMock(getQuote).mockReset();
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve({
        id: Q,
        kind: "project",
        versions: [{ id: "v1", status: "draft", content: content() }],
      }),
    );
    asMock(updateQuoteDraft).mockReset();
    asMock(updateQuoteDraft).mockImplementation(() =>
      Promise.resolve({ id: Q }),
    );
  });

  test("write the text as an edit of the draft, letting go of pictures a removed block held", async () => {
    await call("quotes_remove_text_block", { quoteId: Q, blockId: "photos" });

    const params = asMock(updateQuoteDraft).mock.calls[0]?.[1] as {
      versionId: string;
      edit: (c: QuoteContent) => QuoteContent;
      dropImages: unknown;
    };
    expect(params.versionId).toBe("v1");
    expect(params.edit(content()).blocks.map((b) => b.id)).toEqual([
      "intro",
      "pricing",
    ]);
    expect(typeof params.dropImages).toBe("function");
  });

  test("add a block and move one", async () => {
    await call("quotes_upsert_text_block", {
      quoteId: Q,
      heading: "Timing",
      markdown: "Start in **October**.",
      index: 0,
    });
    const added = asMock(updateQuoteDraft).mock.calls[0]?.[1] as {
      edit: (c: QuoteContent) => QuoteContent;
    };
    const [first] = added.edit(content()).blocks;
    expect(blockDetail(first!)).toMatchObject({
      heading: "Timing",
      markdown: "Start in **October**.",
    });

    await call("quotes_move_block", {
      quoteId: Q,
      blockId: "pricing",
      index: 9,
    });
    const moved = asMock(updateQuoteDraft).mock.calls[1]?.[1] as {
      edit: (c: QuoteContent) => QuoteContent;
    };
    expect(moved.edit(content()).blocks.map((b) => b.id)).toEqual([
      "intro",
      "photos",
      "pricing",
    ]);
  });
});
