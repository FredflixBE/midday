import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";

/**
 * Tables (FF-1642), part of the schema wherever `registerExtensions` builds
 * one — every surface, not only the quote document. Tiptap throws away nodes
 * its schema does not know, so an editor built without these would quietly
 * strip the tables out of text it was only meant to show, and the next
 * keystroke would save the text without them (the lesson `storedImage`
 * records from FF-1625).
 *
 * The grid itself is plain markup, drawn by Tiptap's own `renderHTML`. It is
 * deliberately not a React node view: React's `NodeViewContent` puts a `div`
 * of its own between the `tbody` and the rows, which is not something a
 * table may contain, and the browser hoists the rows out of it. The row and
 * column grips are drawn over the page instead — see `table-controls.tsx`.
 */
export const tableExtensions = [
  Table.configure({
    // No column dragging: every column takes an equal share of the text
    // column, because that is the only width the PDF can draw. react-pdf
    // cannot measure text before it lays it out, so a column sized here
    // would be a column the printed quote disagreed with.
    resizable: false,
  }),
  TableRow,
  TableHeader,
  TableCell.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        // Cells are never merged down: nothing offers it, and none of the
        // four renderers can draw it — a row is a row of cells in all of
        // them. A `rowspan` arriving on a pasted table is flattened at the
        // door, so ProseMirror fills the gap with empty cells rather than
        // letting the rows below silently slide sideways.
        rowspan: { default: 1, parseHTML: () => 1, renderHTML: () => ({}) },
      };
    },
  }),
];
