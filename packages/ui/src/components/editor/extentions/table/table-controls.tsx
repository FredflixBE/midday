"use client";

import type { Editor } from "@tiptap/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../../dropdown-menu";
import {
  type Align,
  type CellRef,
  columnActions,
  columnIsHeader,
  isRectangular,
  rowActions,
  rowIsHeader,
  shapeOf,
  tableAt,
} from "./commands";

/** Where one column or row sits on screen. */
type Band = { start: number; size: number };

/** One line of a handle's menu. */
export type MenuEntry =
  | { kind: "item"; label: string; run: () => void }
  | { kind: "separator" }
  | {
      kind: "submenu";
      label: string;
      items: { label: string; run: () => void }[];
    };

const item = (label: string, run: () => void): MenuEntry => ({
  kind: "item",
  label,
  run,
});
const separator: MenuEntry = { kind: "separator" };

/** Where a column's or a row's content sits across its cells. */
const alignSubmenu = (set: (value: Align | null) => void): MenuEntry => ({
  kind: "submenu",
  label: "Align",
  items: [
    { label: "Left", run: () => set(null) },
    { label: "Centre", run: () => set("center") },
    { label: "Right", run: () => set("right") },
  ],
});

/** Where the cells are, which is not always where the `table` element is. */
type Grid = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

type Measured = {
  ref: Omit<CellRef, "row" | "column">;
  box: Grid;
  columns: Band[];
  rows: Band[];
  /** The column and row the pointer is on, or -1 when it is beside them. */
  atColumn: number;
  atRow: number;
};

/** The handle above a column or beside a row, and the gap it keeps. */
const HANDLE = 6;
const GAP = 4;
/** The bar along the right and bottom edges that adds one more. */
const EDGE = 14;
/** How far beyond the grid the pointer still counts as on it. */
const REACH = EDGE + GAP + 4;
/** The hairline between one handle and the next. */
const SPLIT = 1;

const bandAt = (bands: Band[], at: number) =>
  bands.findIndex((band) => at >= band.start && at < band.start + band.size);

const sameBands = (a: Band[], b: Band[]) =>
  a.length === b.length &&
  a.every(
    (band, i) =>
      Math.abs(band.start - b[i]!.start) < 0.5 &&
      Math.abs(band.size - b[i]!.size) < 0.5,
  );

/** Whether a fresh measurement says anything the last one did not. */
const unchanged = (was: Measured | null, next: Measured) =>
  was !== null &&
  was.ref.table === next.ref.table &&
  was.ref.tablePos === next.ref.tablePos &&
  was.atColumn === next.atColumn &&
  was.atRow === next.atRow &&
  Math.abs(was.box.left - next.box.left) < 0.5 &&
  Math.abs(was.box.top - next.box.top) < 0.5 &&
  sameBands(was.columns, next.columns) &&
  sameBands(was.rows, next.rows);

/**
 * What a table can be changed into (FF-1642), the way Notion does it.
 *
 * Nothing at all until the table is under the pointer. Then: a bar down the
 * right edge and along the bottom, each adding one more column or row, and a
 * single handle above the column and beside the row the pointer is actually
 * on — one each, not a strip of them, so the table still reads as a table.
 *
 * All of it is drawn in the margin, never over the grid, and over the page
 * rather than in the document: the controls must not be part of the text, or
 * ProseMirror would try to put a caret in them and save them with the quote.
 *
 * **Every control carries its own row and column.** One that merely ran
 * `addColumnAfter` would act on wherever the caret happened to be, which is
 * the wrong table as soon as the document holds two. `commands.ts` puts the
 * selection on the named cell first.
 */
export function TableControls({ editor }: { editor: Editor }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [measured, setMeasured] = useState<Measured | null>(null);
  const near = useRef<HTMLTableElement | null>(null);
  const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // While a menu is open the pointer is somewhere else entirely, and the
  // controls have to stay where they are.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;

  /**
   * The table the caret is in, so the controls are not pointer-only.
   *
   * Without this they exist only where the pointer is, which is nowhere at
   * all for anyone working from the keyboard. Tabbing or clicking into a
   * table shows its handles, and `/` offers the same actions inside one
   * (FF-1642).
   */
  const caretTable = useCallback((): HTMLTableElement | null => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name !== "table") continue;
      const element = editor.view.nodeDOM($from.before(depth));
      const grid =
        element instanceof HTMLElement
          ? (element.closest("table") ?? element.querySelector("table"))
          : null;
      if (!grid) return null;

      // Which column and row to draw a handle for: the cell the caret is
      // in, since there is no pointer to take it from.
      const at = editor.view.domAtPos($from.pos).node;
      const cell = (at instanceof HTMLElement ? at : at.parentElement)?.closest(
        "td,th",
      );
      const rect = cell?.getBoundingClientRect();
      if (rect) {
        pointer.current = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return grid as HTMLTableElement;
    }
    return null;
  }, [editor]);

  const measure = useCallback(() => {
    // The table under the pointer, or failing that the one being written in.
    const element = near.current ?? caretTable();
    if (!element?.isConnected) {
      setMeasured(null);
      return;
    }
    const found = tableAt(editor, editor.view.dom as HTMLElement, element);
    if (!found) {
      setMeasured(null);
      return;
    }

    const firstRow = element.querySelector("tr");
    const columns = Array.from(firstRow?.children ?? []).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { start: rect.left, size: rect.width };
    });
    const rows = Array.from(element.querySelectorAll("tr")).map((row) => {
      const rect = row.getBoundingClientRect();
      return { start: rect.top, size: rect.height };
    });

    // The grid is where the cells are, not where the `table` element is. The
    // two can differ — a table element is free to be wider than the columns
    // inside it — and when they do, a bar drawn to the element's edge sits
    // out in the whitespace beside a grid it is supposed to belong to.
    const first = columns[0];
    const last = columns[columns.length - 1];
    const top = rows[0];
    const bottom = rows[rows.length - 1];
    if (!first || !last || !top || !bottom) {
      setMeasured(null);
      return;
    }
    const box = {
      left: first.start,
      right: last.start + last.size,
      top: top.start,
      bottom: bottom.start + bottom.size,
      width: last.start + last.size - first.start,
      height: bottom.start + bottom.size - top.start,
    };

    // The grid is laid out by the browser and the node is changed by
    // ProseMirror, and the two are not always in step on the frame an edit
    // lands. Drawing a handle for a column the node does not have yet asks
    // the table about a cell that is not there, so when the two disagree
    // this draws nothing and waits for the frame where they agree.
    const shape = shapeOf(found.node);
    if (columns.length !== shape.columns || rows.length !== shape.rows) {
      requestAnimationFrame(() => measureRef.current?.());
      return;
    }

    const next: Measured = {
      ref: { editor, table: found.node, tablePos: found.pos },
      box,
      columns,
      rows,
      atColumn: bandAt(columns, pointer.current.x),
      atRow: bandAt(rows, pointer.current.y),
    };

    // Only when something actually moved. This runs on every pointer move
    // over a table, and handing back a new object each time would re-render
    // the whole block sixty times a second for a grid that has not changed —
    // on a document with several blocks, enough to make the page stutter and
    // a save time out under it.
    setMeasured((was) => (unchanged(was, next) ? was : next));
  }, [editor, caretTable]);

  // The re-measure above has to reach the current `measure`, which it cannot
  // name from inside its own definition.
  const measureRef = useRef<() => void>(undefined);
  measureRef.current = measure;

  useEffect(() => {
    const root = editor.view.dom as HTMLElement;
    let pending = 0;

    /**
     * Whether the pointer is on a table or in the margin beside it, asked of
     * the coordinates rather than of mouseenter and mouseleave.
     *
     * The controls sit outside the grid, so reaching for one leaves the
     * editor and arrives in a portal on the body. Deciding from those two
     * events means depending on the order the browser fires them in, and
     * getting it wrong takes the controls away from under the pointer on its
     * way to them. One test against one rectangle has no order to get wrong.
     */
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        if (menuOpenRef.current) return;
        const { x, y } = pointer.current;

        let found: HTMLTableElement | null = null;
        for (const table of root.querySelectorAll("table")) {
          const rect = table.getBoundingClientRect();
          if (
            x >= rect.left - REACH &&
            x <= rect.right + REACH &&
            y >= rect.top - REACH &&
            y <= rect.bottom + REACH
          ) {
            found = table as HTMLTableElement;
            break;
          }
        }

        // Nowhere near a table and none was before: the common case as the
        // pointer crosses the rest of the page. `measure` would only fall
        // back to the caret, which has not moved, so there is nothing to do.
        if (!found && !near.current) return;
        near.current = found;
        measure();
      });
    };

    const again = () => measure();
    document.addEventListener("mousemove", onMove);
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    editor.on("update", again);
    editor.on("selectionUpdate", again);

    return () => {
      document.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
      editor.off("update", again);
      editor.off("selectionUpdate", again);
      if (pending) cancelAnimationFrame(pending);
    };
  }, [editor, measure]);

  if (!mounted || !measured) return null;

  const { ref, box, columns, rows, atColumn, atRow } = measured;
  const shape = shapeOf(ref.table);
  // Duplicating, moving and sorting all name a column by its index, which
  // means nothing across a row whose cells span two columns each.
  const plain = isRectangular(ref.table);
  const act = (action: (cell: CellRef) => void, row: number, column: number) =>
    action({ ...ref, row, column });
  const column = columns[atColumn];
  const row = rows[atRow];

  return createPortal(
    // Fixed to the viewport, because it is measured from the viewport. It
    // takes no room in the document, so showing it moves nothing.
    // `pointer-events` because a Radix modal turns them off on the body.
    <div className="pointer-events-none fixed inset-0 z-40" data-table-controls>
      {column ? (
        <Handle
          kind="column"
          style={{
            left: column.start,
            width: Math.max(1, column.size - SPLIT),
            top: box.top - HANDLE - GAP,
            height: HANDLE,
          }}
          label={`Column ${atColumn + 1}`}
          onOpenChange={setMenuOpen}
          items={[
            item("Insert column left", () =>
              act(columnActions.insertBefore, 0, atColumn),
            ),
            item("Insert column right", () =>
              act(columnActions.insertAfter, 0, atColumn),
            ),
            separator,
            alignSubmenu((value) =>
              columnActions.align({ ...ref, row: 0, column: atColumn }, value),
            ),
            ...(plain
              ? [
                  separator,
                  item("Duplicate column", () =>
                    act(columnActions.duplicate, 0, atColumn),
                  ),
                  ...(atColumn > 0
                    ? [
                        item("Move left", () =>
                          columnActions.move(
                            { ...ref, row: 0, column: atColumn },
                            -1,
                          ),
                        ),
                      ]
                    : []),
                  ...(atColumn < shape.columns - 1
                    ? [
                        item("Move right", () =>
                          columnActions.move(
                            { ...ref, row: 0, column: atColumn },
                            1,
                          ),
                        ),
                      ]
                    : []),
                  separator,
                  item("Sort A–Z", () =>
                    columnActions.sort({ ...ref, row: 0, column: atColumn }, 1),
                  ),
                  item("Sort Z–A", () =>
                    columnActions.sort(
                      { ...ref, row: 0, column: atColumn },
                      -1,
                    ),
                  ),
                ]
              : []),
            separator,
            item(
              columnIsHeader(ref.table, atColumn)
                ? "Remove header column"
                : "Header column",
              () => act(columnActions.toggleHeader, 0, atColumn),
            ),
            separator,
            ...(shape.columns > 1
              ? [
                  item("Delete column", () =>
                    act(columnActions.remove, 0, atColumn),
                  ),
                ]
              : []),
            item("Delete table", () =>
              act(columnActions.removeTable, 0, atColumn),
            ),
          ]}
        />
      ) : null}

      {row ? (
        <Handle
          kind="row"
          style={{
            top: row.start,
            height: Math.max(1, row.size - SPLIT),
            left: box.left - HANDLE - GAP,
            width: HANDLE,
          }}
          label={`Row ${atRow + 1}`}
          onOpenChange={setMenuOpen}
          items={[
            item("Insert row above", () =>
              act(rowActions.insertBefore, atRow, 0),
            ),
            item("Insert row below", () =>
              act(rowActions.insertAfter, atRow, 0),
            ),
            separator,
            alignSubmenu((value) =>
              rowActions.align({ ...ref, row: atRow, column: 0 }, value),
            ),
            ...(plain
              ? [
                  separator,
                  item("Duplicate row", () =>
                    act(rowActions.duplicate, atRow, 0),
                  ),
                  ...(atRow > 0
                    ? [
                        item("Move up", () =>
                          rowActions.move(
                            { ...ref, row: atRow, column: 0 },
                            -1,
                          ),
                        ),
                      ]
                    : []),
                  ...(atRow < shape.rows - 1
                    ? [
                        item("Move down", () =>
                          rowActions.move({ ...ref, row: atRow, column: 0 }, 1),
                        ),
                      ]
                    : []),
                ]
              : []),
            separator,
            item(
              rowIsHeader(ref.table, atRow)
                ? "Remove header row"
                : "Header row",
              () => act(rowActions.toggleHeader, atRow, 0),
            ),
            separator,
            ...(shape.rows > 1
              ? [item("Delete row", () => act(rowActions.remove, atRow, 0))]
              : []),
            item("Delete table", () => act(rowActions.removeTable, atRow, 0)),
          ]}
        />
      ) : null}

      {/* One more column, down the right-hand edge; one more row, along the
          bottom. The whole edge is the target, the way Notion has it. */}
      <Edge
        label="Add column"
        style={{
          left: box.right + GAP,
          top: box.top,
          width: EDGE,
          height: box.height,
        }}
        onClick={() =>
          act(columnActions.insertAfter, 0, Math.max(0, shape.columns - 1))
        }
      />
      <Edge
        label="Add row"
        style={{
          left: box.left,
          top: box.bottom + GAP,
          width: box.width,
          height: EDGE,
        }}
        onClick={() =>
          act(rowActions.insertAfter, Math.max(0, shape.rows - 1), 0)
        }
      />
    </div>,
    document.body,
  );
}

function Handle({
  kind,
  style,
  label,
  items,
  onOpenChange,
}: {
  kind: "row" | "column";
  style: React.CSSProperties;
  label: string;
  items: MenuEntry[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-table-grip={kind}
          style={style}
          // The handle takes the click without taking the caret: what is
          // being written keeps it, and the action puts the selection
          // exactly where it needs it.
          onMouseDown={(event) => event.preventDefault()}
          className="pointer-events-auto fixed bg-border transition-colors hover:bg-muted-foreground focus-visible:bg-muted-foreground focus-visible:outline-hidden"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <MenuEntries items={items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuEntries({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((entry, index) => {
        if (entry.kind === "separator") {
          // Two separators running together, or one at either end, is what
          // you get when a whole group is left out; they are dropped here
          // rather than guarded at every call site.
          const before = items[index - 1];
          const after = items[index + 1];
          if (!before || !after || before.kind === "separator") return null;
          return (
            <DropdownMenuSeparator key={`separator-${index.toString()}`} />
          );
        }
        if (entry.kind === "submenu") {
          return (
            <DropdownMenuSub key={entry.label}>
              <DropdownMenuSubTrigger>{entry.label}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {entry.items.map((sub) => (
                  <DropdownMenuItem key={sub.label} onSelect={sub.run}>
                    {sub.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }
        return (
          <DropdownMenuItem key={entry.label} onSelect={entry.run}>
            {entry.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function Edge({
  label,
  style,
  onClick,
}: {
  label: string;
  style: React.CSSProperties;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      style={style}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      // Outlined, not filled: the document pane holds no filled controls,
      // and a bar the width of the table would be a slab of colour across
      // it. What answers the pointer is the line and the glyph.
      className="pointer-events-auto fixed flex items-center justify-center border border-border text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground focus-visible:border-muted-foreground focus-visible:outline-hidden"
    >
      <Plus className="size-3" />
    </button>
  );
}
