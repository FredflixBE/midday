import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";

/**
 * What a cell carries, for both kinds of cell.
 *
 * `colwidth` is deliberately not among them. It is where a dragged column
 * width is kept, nothing here drags, and a width left on a cell by an older
 * table is the one thing that can make a grid narrower than the text column
 * it sits in — so it is neither read nor written.
 *
 * `rowspan` is fixed at one for a related reason: nothing offers to merge
 * cells down and none of the four renderers can draw a merged one, so a span
 * arriving on a pasted table is flattened at the door and ProseMirror fills
 * the gap with empty cells rather than letting the rows below slide
 * sideways. A `colspan` is drawn by every renderer, so it is kept.
 */
const cellAttributes = {
  colspan: { default: 1 },
  /**
   * How the cell's content sits across it. Kept on the cell rather than
   * worked out from the column, because that is what every renderer reads —
   * and a right-aligned column of numbers has to print right-aligned, not
   * only look it on screen.
   */
  align: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-align"),
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.align ? { "data-align": attrs.align as string } : {},
  },
  rowspan: { default: 1, parseHTML: () => 1, renderHTML: () => ({}) },
  colwidth: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
};

/**
 * Tables (FF-1642), part of the schema wherever `registerExtensions` builds
 * one — every surface, not only the quote document. Tiptap throws away nodes
 * its schema does not know, so an editor built without these would quietly
 * strip the tables out of text it was only meant to show, and the next
 * keystroke would save the text without them (the lesson `storedImage`
 * records from FF-1625).
 *
 * The row and column controls are drawn over the page rather than in the
 * document — see `table-controls.tsx`.
 */
export const tableExtensions = [
  Table.extend({
    /**
     * A plain `table` with a `tbody`, and no `colgroup`.
     *
     * Tiptap's own table view keeps a `col` element per column so a dragged
     * width has somewhere to live. It does not take one away again when a
     * column is deleted, and under `table-layout: fixed` the browser sizes
     * the grid from that stale list — so deleting a column left the others
     * at their old width and the last one swallowed the gap.
     *
     * Nothing here resizes, so there is nothing for a `colgroup` to carry,
     * and without one every column is simply an equal share of the width.
     * Written by hand rather than as a React view: `NodeViewContent` puts a
     * `div` of its own between the `tbody` and the rows, which a table may
     * not contain.
     */
    addNodeView() {
      return () => {
        const dom = document.createElement("table");
        const contentDOM = document.createElement("tbody");
        dom.appendChild(contentDOM);
        return { dom, contentDOM };
      };
    },
  }).configure({
    // No column dragging: every column takes an equal share of the text
    // column, because that is the only width the PDF can draw. react-pdf
    // cannot measure text before it lays it out, so a column sized here
    // would be a column the printed quote disagreed with.
    resizable: false,
  }),
  TableRow,
  TableHeader.extend({ addAttributes: () => cellAttributes }),
  TableCell.extend({ addAttributes: () => cellAttributes }),
];
