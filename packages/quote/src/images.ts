import type { Block, EditorDoc, QuoteContent } from "./content";

/**
 * Every picture a quote's text holds, by the path it is stored under
 * (FF-1625). The PDF is drawn on the server, where a stored path is not an
 * address anything can fetch, so whoever renders has to read the bytes first
 * and this says which. Each path is named once, in the order it is written.
 *
 * A diagram counts as a picture here (FF-1643): it is drawn to one when it
 * is written, and that PNG is stored beside the text like any other. This
 * one list is what the PDF reads its bytes from, what a save keeps, and what
 * FF-1626 deletes from — so a kind of picture missing from it is dropped
 * from every sent quote and never cleaned up either.
 */
export function imagePathsIn(content: QuoteContent): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      const {
        type,
        attrs,
        content: children,
      } = node as {
        type?: string;
        attrs?: { path?: unknown };
        content?: unknown;
      };
      const holdsPicture = type === "image" || type === "diagram";
      if (holdsPicture && typeof attrs?.path === "string" && attrs.path) {
        if (!seen.has(attrs.path)) {
          seen.add(attrs.path);
          paths.push(attrs.path);
        }
      }
      if (Array.isArray(children)) {
        walk(children);
      }
    }
  };

  for (const block of content.blocks as Block[]) {
    if (block.type === "text") {
      walk((block.body as EditorDoc).content);
    }
  }

  return paths;
}
