import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";

/** What reading an attr off the markup needs of an element, typed without the DOM. */
type MarkupElement = { getAttribute(name: string): string | null };

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
export const cellAttributes = {
  colspan: { default: 1 },
  /**
   * How the cell's content sits across it. Kept on the cell rather than
   * worked out from the column, because that is what every renderer reads —
   * and a right-aligned column of numbers has to print right-aligned, not
   * only look it on screen.
   */
  align: {
    default: null,
    parseHTML: (element: MarkupElement) => element.getAttribute("data-align"),
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.align ? { "data-align": attrs.align as string } : {},
  },
  rowspan: { default: 1, parseHTML: () => 1, renderHTML: () => ({}) },
  colwidth: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
};

/**
 * No column dragging: every column takes an equal share of the text column,
 * because that is the only width the PDF can draw. react-pdf cannot measure
 * text before it lays it out, so a column sized here would be a column the
 * printed quote disagreed with.
 */
export const tableOptions = { resizable: false };

/**
 * The four table nodes as the schema knows them, without the view the editor
 * draws a table with (`./index.ts`): what a server needs to read and write a
 * table (FF-1791), and all it can build without a browser.
 */
export const tableNodes = [
  Table.configure(tableOptions),
  TableRow,
  TableHeader.extend({ addAttributes: () => cellAttributes }),
  TableCell.extend({ addAttributes: () => cellAttributes }),
];
