import type { Block, EditorDoc, QuoteContent } from "./content";

/**
 * Every picture a quote's text holds, by the path it is stored under
 * (FF-1625). The PDF is drawn on the server, where a stored path is not an
 * address anything can fetch, so whoever renders has to read the bytes first
 * and this says which. Each path is named once, in the order it is written.
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
      if (type === "image" && typeof attrs?.path === "string" && attrs.path) {
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
