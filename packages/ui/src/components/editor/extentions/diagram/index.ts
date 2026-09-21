import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { StoredImages } from "../stored-image";
import { DiagramView } from "./diagram-view";

export type DiagramOptions = {
  /** Where the picture a diagram was drawn into is stored and shown from. */
  images?: StoredImages;
  /** True where a diagram may be written here, not only shown (FF-1643). */
  canEdit?: boolean;
};

/**
 * A mermaid diagram (FF-1643). The node holds two things: the source, which
 * is what makes it editable again, and the path of the picture that source
 * was drawn into, which is what every renderer already understands.
 *
 * Drawn once, when it is written. Mermaid draws SVG in a browser, and
 * react-pdf draws neither the whole of SVG nor the `foreignObject` mermaid
 * puts its text in — so "let each renderer draw it" would mean a second
 * renderer for the PDF or a headless browser at send time. A picture costs
 * the renderers nothing, because they already draw pictures (FF-1625).
 *
 * A stored picture is never redrawn on its own. Mermaid's output shifts
 * between versions, and a quote redrawing itself because a dependency moved
 * is a document nobody edited that no longer says what its author approved.
 * It is drawn again when someone opens the diagram and saves it, and only
 * then.
 *
 * Part of the schema wherever `registerExtensions` builds one, whether or
 * not a diagram can be written there: Tiptap throws away nodes its schema
 * does not know, so an editor built without this would strip the diagrams
 * out of text it was only meant to show.
 */
export const Diagram = Node.create<DiagramOptions>({
  name: "diagram",
  group: "block",
  // Whole and alone on its line: there is nothing inside a diagram to put a
  // caret in, and its source is edited in a dialog rather than in the text.
  atom: true,
  draggable: true,

  addOptions() {
    return { images: undefined, canEdit: false };
  },

  addAttributes() {
    // Read back off the markup as well as out of the saved JSON: a diagram
    // copied from one block and pasted into another goes through HTML, and
    // without these it would arrive stripped of both the things that make it
    // a diagram.
    return {
      /** The mermaid the picture was drawn from. */
      source: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-source") ?? "",
      },
      /** The picture's place in storage, never a public address. */
      path: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-path"),
      },
    };
  },

  parseHTML() {
    return [{ tag: "figure[data-diagram]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const { source, path } = HTMLAttributes as {
      source?: string;
      path?: string | null;
    };
    return [
      "figure",
      {
        "data-diagram": "",
        "data-source": source ?? "",
        "data-path": path ?? null,
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramView);
  },
});

export function diagram(options?: DiagramOptions) {
  return Diagram.configure(options);
}
