import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";

/**
 * Tables (FF-1642), on the same terms as pictures (FF-1625): part of the
 * schema wherever `registerExtensions` builds one, whether or not a table can
 * be written there. Tiptap throws away nodes its schema does not know, so an
 * editor built without these would quietly strip the tables out of text it
 * was only meant to show — and the next keystroke would save the text
 * without them.
 *
 * Being in the schema is not the same as offering one, though: only the
 * quote document offers to write a table, so an editor that does not parses
 * no `<table>` either, and a table pasted into an invoice note arrives as
 * the words it holds rather than as a grid that surface never offers.
 */
export function tableExtensions(enabled?: boolean) {
  return [
    Table.extend({
      parseHTML() {
        return enabled ? [{ tag: "table" }] : [];
      },
    }).configure({
      // No column dragging: every column takes an equal share of the text
      // column, because that is the only width the PDF can draw. react-pdf
      // cannot measure text before it lays it out, so a column sized here
      // would be a column the printed quote disagreed with.
      resizable: false,
    }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}
