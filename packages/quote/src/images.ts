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

/**
 * The prefix a picture carries while it is only in the browser (FF-1634).
 *
 * A picture is uploaded when the draft that names it is saved, not when it
 * is picked or drawn, so nothing reaches storage that no version ever
 * pointed at. Until then the node carries one of these in place of a path.
 */
export const PENDING_IMAGE = "pending:";

/** Whether this is a picture the browser is still holding. */
export function isPendingImage(path: string): boolean {
  return path.startsWith(PENDING_IMAGE);
}

/**
 * The same content with each named path put in place of the one it stands
 * for — how a stand-in becomes a stored path on the way to the server.
 *
 * It walks exactly as `imagePathsIn` does, so the two cannot disagree about
 * what counts as a picture; a path nothing was stored for is left alone.
 */
export function replaceImagePaths(
  content: QuoteContent,
  stored: Record<string, string>,
): QuoteContent {
  if (Object.keys(stored).length === 0) return content;

  const walk = (nodes: unknown[]): unknown[] =>
    nodes.map((node) => {
      const {
        type,
        attrs,
        content: children,
      } = node as {
        type?: string;
        attrs?: { path?: unknown };
        content?: unknown;
      };

      const next = node as Record<string, unknown>;
      const holdsPicture = type === "image" || type === "diagram";
      const replacement =
        holdsPicture && typeof attrs?.path === "string"
          ? stored[attrs.path]
          : undefined;

      return {
        ...next,
        ...(replacement ? { attrs: { ...attrs, path: replacement } } : {}),
        ...(Array.isArray(children) ? { content: walk(children) } : {}),
      };
    });

  return {
    ...content,
    blocks: (content.blocks as Block[]).map((block) =>
      block.type === "text"
        ? {
            ...block,
            body: {
              ...(block.body as EditorDoc),
              content: walk((block.body as EditorDoc).content),
            },
          }
        : block,
    ),
  } as QuoteContent;
}
