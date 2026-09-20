import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";

/**
 * Where a table's cells are, so an action can name the one it means.
 *
 * Every table command in ProseMirror reads the current selection to work out
 * which row and column it applies to. A control that only runs the command
 * therefore acts on wherever the caret happens to be — which, once the caret
 * is stale or the document holds a second table, is not the table the person
 * is pointing at. Each control here carries its own row and column, puts the
 * selection on that cell first, and only then runs the command.
 */
function cellAt(
  table: ProseMirrorNode,
  tablePos: number,
  row: number,
  column: number,
): number | null {
  const map = TableMap.get(table);
  if (row >= map.height || column >= map.width) return null;
  // `map.map` is offsets from just inside the table node.
  return tablePos + 1 + map.map[row * map.width + column]!;
}

export type CellRef = {
  editor: Editor;
  table: ProseMirrorNode;
  tablePos: number;
  row: number;
  column: number;
};

/**
 * Runs one table command with the selection put on the cell the action
 * names.
 *
 * The selection is set in its own step rather than at the head of a chain.
 * A chain builds every command against the state it started from, so a
 * command that reads the selection would read the one from before the cell
 * was picked — the two have to be separate transactions.
 *
 * Focus comes last, after the change: taking it first hands the caret back
 * to the text and moves the selection off the cell again.
 */
function runAt(
  { editor, table, tablePos, row, column }: CellRef,
  command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>,
) {
  const anchorCell = cellAt(table, tablePos, row, column);
  if (anchorCell === null) return false;
  if (!editor.commands.setCellSelection({ anchorCell })) return false;
  return command(editor.chain()).focus().run();
}

export const columnActions = {
  insertBefore: (ref: CellRef) => runAt(ref, (c) => c.addColumnBefore()),
  insertAfter: (ref: CellRef) => runAt(ref, (c) => c.addColumnAfter()),
  remove: (ref: CellRef) => runAt(ref, (c) => c.deleteColumn()),
  toggleHeader: (ref: CellRef) => runAt(ref, (c) => c.toggleHeaderColumn()),
};

export const rowActions = {
  insertBefore: (ref: CellRef) => runAt(ref, (c) => c.addRowBefore()),
  insertAfter: (ref: CellRef) => runAt(ref, (c) => c.addRowAfter()),
  remove: (ref: CellRef) => runAt(ref, (c) => c.deleteRow()),
  toggleHeader: (ref: CellRef) => runAt(ref, (c) => c.toggleHeaderRow()),
};

/**
 * The table a rendered `<table>` belongs to, and where it starts.
 *
 * Asked of the DOM rather than of the selection, because the whole point of
 * the grips is that they act on the table being pointed at.
 *
 * Matched by order rather than by `posAtDOM`, which answers about the node
 * around a position and does not reliably resolve a table element itself.
 * Both lists are in document order — a depth-first walk of the document and
 * `querySelectorAll` agree — so the nth grid on the page is the nth table in
 * the text.
 */
export function tableAt(
  editor: Editor,
  root: HTMLElement,
  element: HTMLElement,
): { node: ProseMirrorNode; pos: number } | null {
  const grids = Array.from(root.querySelectorAll("table"));
  const index = grids.indexOf(element as HTMLTableElement);
  if (index < 0) return null;

  let seen = 0;
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== "table") return true;
    if (seen === index) {
      found = { node, pos };
      return false;
    }
    seen++;
    // Keep descending. A cell may hold a table, and `querySelectorAll`
    // counts those too — skipping them here would put the two lists out of
    // step and point every grip at the wrong grid.
    return true;
  });
  return found;
}

/** How many rows and columns the table has, from its own map. */
export function shapeOf(table: ProseMirrorNode) {
  const map = TableMap.get(table);
  return { rows: map.height, columns: map.width };
}

/**
 * True when every cell down that column, or across that row, is a header
 * cell.
 *
 * Both are asked with an index that came from the laid-out grid, which can
 * be a frame ahead of the node — an out-of-range index is a question about a
 * column that does not exist yet, and the honest answer is "no", not a
 * thrown error that takes the page down with it.
 */
function everyCellIsHeader(
  table: ProseMirrorNode,
  count: number,
  offsetOf: (index: number, map: TableMap) => number | undefined,
) {
  const map = TableMap.get(table);
  if (map.width === 0 || map.height === 0 || count === 0) return false;
  for (let index = 0; index < count; index++) {
    const offset = offsetOf(index, map);
    if (offset === undefined) return false;
    if (table.nodeAt(offset)?.type.name !== "tableHeader") return false;
  }
  return true;
}

export function columnIsHeader(table: ProseMirrorNode, column: number) {
  const map = TableMap.get(table);
  if (column >= map.width) return false;
  return everyCellIsHeader(
    table,
    map.height,
    (row, m) => m.map[row * m.width + column],
  );
}

export function rowIsHeader(table: ProseMirrorNode, row: number) {
  const map = TableMap.get(table);
  if (row >= map.height) return false;
  return everyCellIsHeader(
    table,
    map.width,
    (column, m) => m.map[row * m.width + column],
  );
}
