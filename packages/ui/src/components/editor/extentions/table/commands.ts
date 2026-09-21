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

/** How a cell's content sits across it. */
export type Align = "left" | "center" | "right";

/**
 * A selection covering a whole column or a whole row, so an attribute set
 * on it reaches every cell rather than only the one under the handle.
 */
function spanOf(
  { editor, table, tablePos, row, column }: CellRef,
  whole: "column" | "row",
) {
  const map = TableMap.get(table);
  const [anchorCell, headCell] =
    whole === "column"
      ? [
          cellAt(table, tablePos, 0, column),
          cellAt(table, tablePos, map.height - 1, column),
        ]
      : [
          cellAt(table, tablePos, row, 0),
          cellAt(table, tablePos, row, map.width - 1),
        ];
  if (anchorCell === null || headCell === null) return false;
  return editor.commands.setCellSelection({ anchorCell, headCell });
}

const align =
  (whole: "column" | "row") => (ref: CellRef, value: Align | null) => {
    if (!spanOf(ref, whole)) return false;
    return ref.editor.chain().setCellAttribute("align", value).focus().run();
  };

/**
 * Rebuilding the table wholesale, rather than moving cells about inside it.
 *
 * Duplicating, moving and sorting all shuffle whole rows or whole columns,
 * and doing that in place means deleting and inserting at positions that
 * move under each other as the transaction is built. Replacing the node with
 * one assembled from the same cells is a single step that cannot get the
 * arithmetic wrong, and the cells themselves are reused untouched.
 */
function rebuild(
  { editor, table, tablePos }: CellRef,
  rows: ProseMirrorNode[],
) {
  const next = table.type.create(table.attrs, rows, table.marks);
  editor.view.dispatch(
    editor.state.tr.replaceWith(tablePos, tablePos + table.nodeSize, next),
  );
  editor.commands.focus();
  return true;
}

const rowsOf = (table: ProseMirrorNode) => {
  const out: ProseMirrorNode[] = [];
  table.forEach((row) => {
    out.push(row);
  });
  return out;
};

const cellsOf = (row: ProseMirrorNode) => {
  const out: ProseMirrorNode[] = [];
  row.forEach((cell) => {
    out.push(cell);
  });
  return out;
};

const withCells = (row: ProseMirrorNode, cells: ProseMirrorNode[]) =>
  row.type.create(row.attrs, cells, row.marks);

/**
 * True when every row has the same cells and none of them spans columns.
 *
 * Duplicating, moving and sorting all name a column by its index, and an
 * index means nothing across a row whose cells span two columns each. A
 * merged table can still be edited every other way; these four are simply
 * not offered for it.
 */
export function isRectangular(table: ProseMirrorNode) {
  const width = TableMap.get(table).width;
  let plain = true;
  table.forEach((row) => {
    if (row.childCount !== width) plain = false;
    row.forEach((cell) => {
      if ((cell.attrs.colspan ?? 1) !== 1) plain = false;
    });
  });
  return plain;
}

/** The words in a cell, for sorting by them. */
const textOf = (cell: ProseMirrorNode) => cell.textContent.trim();

function sortRows(ref: CellRef, direction: 1 | -1) {
  const rows = rowsOf(ref.table);
  // A header row keeps its place at the top; only what is under it moves.
  let heading = 0;
  while (heading < rows.length && rowIsHeaderNode(rows[heading]!)) heading++;
  const head = rows.slice(0, heading);
  const body = rows.slice(heading);

  const sorted = [...body].sort((a, b) => {
    const left = textOf(cellsOf(a)[ref.column]!);
    const right = textOf(cellsOf(b)[ref.column]!);
    // An empty cell sorts to the end either way: it says nothing, and
    // burying the filled rows under it is never what was meant.
    if (!left !== !right) return left ? -1 : 1;
    return left.localeCompare(right, undefined, { numeric: true }) * direction;
  });

  return rebuild(ref, [...head, ...sorted]);
}

const rowIsHeaderNode = (row: ProseMirrorNode) => {
  let all = row.childCount > 0;
  row.forEach((cell) => {
    if (cell.type.name !== "tableHeader") all = false;
  });
  return all;
};

/** Where an index lands after moving by `delta`, or null when it cannot. */
const movedTo = (index: number, delta: number, count: number) => {
  const to = index + delta;
  return to < 0 || to >= count ? null : to;
};

function reorder<T>(items: T[], from: number, to: number) {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Taking the whole table out, offered from either handle's menu. */
const removeTable = (ref: CellRef) => runAt(ref, (c) => c.deleteTable());

export const columnActions = {
  removeTable,
  insertBefore: (ref: CellRef) => runAt(ref, (c) => c.addColumnBefore()),
  insertAfter: (ref: CellRef) => runAt(ref, (c) => c.addColumnAfter()),
  remove: (ref: CellRef) => runAt(ref, (c) => c.deleteColumn()),
  toggleHeader: (ref: CellRef) => runAt(ref, (c) => c.toggleHeaderColumn()),
  align: align("column"),
  duplicate: (ref: CellRef) =>
    rebuild(
      ref,
      rowsOf(ref.table).map((row) => {
        const cells = cellsOf(row);
        const copied = cells[ref.column];
        return copied
          ? withCells(row, [
              ...cells.slice(0, ref.column + 1),
              copied,
              ...cells.slice(ref.column + 1),
            ])
          : row;
      }),
    ),
  move: (ref: CellRef, delta: number) => {
    const to = movedTo(ref.column, delta, TableMap.get(ref.table).width);
    if (to === null) return false;
    return rebuild(
      ref,
      rowsOf(ref.table).map((row) =>
        withCells(row, reorder(cellsOf(row), ref.column, to)),
      ),
    );
  },
  sort: (ref: CellRef, direction: 1 | -1) => sortRows(ref, direction),
};

export const rowActions = {
  removeTable,
  insertBefore: (ref: CellRef) => runAt(ref, (c) => c.addRowBefore()),
  insertAfter: (ref: CellRef) => runAt(ref, (c) => c.addRowAfter()),
  remove: (ref: CellRef) => runAt(ref, (c) => c.deleteRow()),
  toggleHeader: (ref: CellRef) => runAt(ref, (c) => c.toggleHeaderRow()),
  align: align("row"),
  duplicate: (ref: CellRef) => {
    const rows = rowsOf(ref.table);
    const copied = rows[ref.row];
    if (!copied) return false;
    return rebuild(ref, [
      ...rows.slice(0, ref.row + 1),
      copied,
      ...rows.slice(ref.row + 1),
    ]);
  },
  move: (ref: CellRef, delta: number) => {
    const rows = rowsOf(ref.table);
    const to = movedTo(ref.row, delta, rows.length);
    if (to === null) return false;
    return rebuild(ref, reorder(rows, ref.row, to));
  },
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
