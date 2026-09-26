import { ReactNodeViewRenderer } from "@tiptap/react";
import { DiagramView } from "./diagram-view";
import { DiagramNode, type DiagramOptions } from "./node";

export type { DiagramOptions } from "./node";

/**
 * The diagram as the editor draws it: the node, and the view that shows its
 * picture and opens its source. The node alone is what the schema needs, and
 * lives apart so a server can build the schema without React (FF-1791).
 */
export const Diagram = DiagramNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DiagramView);
  },
});

export function diagram(options?: DiagramOptions) {
  return Diagram.configure(options);
}
