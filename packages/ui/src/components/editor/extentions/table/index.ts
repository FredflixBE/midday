import Table from "@tiptap/extension-table";
import { tableCellNodes, tableOptions } from "./node";

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
  }).configure(tableOptions),
  ...tableCellNodes,
];
