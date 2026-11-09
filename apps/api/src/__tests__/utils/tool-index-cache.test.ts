import { describe, expect, test } from "bun:test";
import { toolIndexCachePath } from "@api/chat/tool-index-cache";

const tools = [
  { name: "invoices_list", description: "List invoices", inputSchema: {} },
  { name: "customers_list", description: "List customers", inputSchema: {} },
];

describe("toolIndexCachePath", () => {
  test("is the same for the same model and the same tools", () => {
    expect(toolIndexCachePath("gemini-embedding-001", tools)).toBe(
      toolIndexCachePath("gemini-embedding-001", structuredClone(tools)),
    );
  });

  test("changes with the embedding model, so another model's vectors are never reused", () => {
    // toolpick only checks that the cached list is as long as the tool list,
    // so a cache written by text-embedding-3-small would be read back for
    // Gemini queries and every search would be wrong, silently.
    expect(toolIndexCachePath("gemini-embedding-001", tools)).not.toBe(
      toolIndexCachePath("text-embedding-3-small", tools),
    );
  });

  test("changes when a tool's description changes", () => {
    const edited = [
      { ...tools[0]!, description: "List and filter invoices" },
      tools[1]!,
    ];

    expect(toolIndexCachePath("gemini-embedding-001", tools)).not.toBe(
      toolIndexCachePath("gemini-embedding-001", edited),
    );
  });

  test("is a file the repository already ignores", () => {
    expect(toolIndexCachePath("gemini-embedding-001", tools)).toMatch(
      /^\.toolpick-cache-[0-9a-f]{12}\.json$/,
    );
  });
});
