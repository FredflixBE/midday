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
  DropdownMenuTrigger,
} from "../../../dropdown-menu";
import {
  type CellRef,
  columnActions,
  columnIsHeader,
  rowActions,
  rowIsHeader,
  shapeOf,
  tableAt,
} from "./commands";

/** Where one column or row sits on screen. */
type Band = { start: number; size: number };

type Measured = {
  element: HTMLTableElement;
  ref: Omit<CellRef, "row" | "column">;
  box: DOMRect;
  columns: Band[];
  rows: Band[];
};

/** The grip itself, and the gap it keeps from the grid. */
const GRIP = 10;
const GAP = 4;
/** How far beyond the grid the pointer still counts as on it. */
const REACH = GRIP + GAP + 6;
/** The hairline between one grip and the next, so they read as one each. */
const SPLIT = 1;

/**
 * The row and column grips (FF-1642), the way Notion draws them: a strip
 * above every column and beside every row, appearing only while the table is
 * under the pointer, and always in the margin — never over the grid, so the
 * words being written are never covered and nothing on the page moves.
 *
 * Drawn over the page rather than inside the document. Two reasons: React
 * cannot own anything inside a table's markup without putting a `div` where
 * only rows may go, and the controls must not be part of the text, or
 * ProseMirror would try to put a caret in them and save them with the quote.
 *
 * **Every grip carries its own row and column.** A control that merely ran
 * `addColumnAfter` would act on wherever the caret happened to be, which is
 * the wrong table as soon as the document holds two — and nothing at all
 * once the caret has gone stale. `commands.ts` puts the selection on the
 * named cell first.
 */
export function TableControls({ editor }: { editor: Editor }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [measured, setMeasured] = useState<Measured | null>(null);
  // Which table the pointer is near. A ref, because the listener below is
  // attached once and would otherwise keep reading the first value it saw.
  const near = useRef<HTMLTableElement | null>(null);
  // While a grip's menu is open the pointer is somewhere else entirely, and
  // the grips have to stay where they are.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;

  const measure = useCallback(() => {
    const element = near.current;
    if (!element?.isConnected) {
      setMeasured(null);
      return;
    }
    const found = tableAt(editor, editor.view.dom as HTMLElement, element);
    if (!found) {
      setMeasured(null);
      return;
    }

    const box = element.getBoundingClientRect();
    const firstRow = element.querySelector("tr");
    const columns = Array.from(firstRow?.children ?? []).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { start: rect.left, size: rect.width };
    });
    const rows = Array.from(element.querySelectorAll("tr")).map((row) => {
      const rect = row.getBoundingClientRect();
      return { start: rect.top, size: rect.height };
    });

    // The grid is laid out by the browser and the node is changed by
    // ProseMirror, and the two are not always in step on the frame an edit
    // lands. Drawing a grip for a column the node does not have yet asks the
    // table about a cell that is not there, so when the two disagree this
    // draws nothing and waits for the frame where they agree.
    const shape = shapeOf(found.node);
    if (columns.length !== shape.columns || rows.length !== shape.rows) {
      requestAnimationFrame(() => measureRef.current?.());
      return;
    }

    setMeasured({
      element,
      ref: { editor, table: found.node, tablePos: found.pos },
      box,
      columns,
      rows,
    });
  }, [editor]);

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
     * The grips sit outside the grid, so reaching for one leaves the editor
     * and entering one arrives in a portal on the body. Deciding from those
     * two events means depending on the order the browser fires them in, and
     * getting it wrong takes the grips away from under the pointer on its
     * way to them. One test against one rectangle has no order to get wrong.
     */
    const onMove = (event: MouseEvent) => {
      if (pending) return;
      const { clientX: x, clientY: y } = event;
      pending = requestAnimationFrame(() => {
        pending = 0;
        if (menuOpenRef.current) return;

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

        if (found !== near.current) {
          near.current = found;
          measure();
        }
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

  const { ref, box, columns, rows } = measured;
  const shape = shapeOf(ref.table);
  const act = (action: (cell: CellRef) => void, row: number, column: number) =>
    action({ ...ref, row, column });

  return createPortal(
    // Fixed to the viewport, because it is measured from the viewport. It
    // takes no room in the document, so showing it moves nothing.
    // `pointer-events` because a Radix modal turns them off on the body.
    <div className="pointer-events-none fixed inset-0 z-40" data-table-controls>
      {columns.map((band, column) => (
        <Grip
          key={`column-${column.toString()}`}
          kind="column"
          style={{
            left: band.start,
            width: Math.max(1, band.size - SPLIT),
            top: box.top - GRIP - GAP,
            height: GRIP,
          }}
          label={`Column ${column + 1}`}
          isHeader={columnIsHeader(ref.table, column)}
          headerLabel="Header column"
          insertBefore="Insert column left"
          insertAfter="Insert column right"
          remove="Delete column"
          removable={shape.columns > 1}
          onOpenChange={setMenuOpen}
          onInsertBefore={() => act(columnActions.insertBefore, 0, column)}
          onInsertAfter={() => act(columnActions.insertAfter, 0, column)}
          onRemove={() => act(columnActions.remove, 0, column)}
          onToggleHeader={() => act(columnActions.toggleHeader, 0, column)}
        />
      ))}

      {rows.map((band, row) => (
        <Grip
          key={`row-${row.toString()}`}
          kind="row"
          style={{
            top: band.start,
            height: Math.max(1, band.size - SPLIT),
            left: box.left - GRIP - GAP,
            width: GRIP,
          }}
          label={`Row ${row + 1}`}
          isHeader={rowIsHeader(ref.table, row)}
          headerLabel="Header row"
          insertBefore="Insert row above"
          insertAfter="Insert row below"
          remove="Delete row"
          removable={shape.rows > 1}
          onOpenChange={setMenuOpen}
          onInsertBefore={() => act(rowActions.insertBefore, row, 0)}
          onInsertAfter={() => act(rowActions.insertAfter, row, 0)}
          onRemove={() => act(rowActions.remove, row, 0)}
          onToggleHeader={() => act(rowActions.toggleHeader, row, 0)}
        />
      ))}

      {/* One click to put a column on the end, and one for a row. */}
      <Add
        label="Add column"
        style={{
          left: box.right + GAP,
          top: box.top - GRIP - GAP,
          width: GRIP + 6,
          height: GRIP,
        }}
        onClick={() =>
          act(columnActions.insertAfter, 0, Math.max(0, shape.columns - 1))
        }
      />
      <Add
        label="Add row"
        style={{
          left: box.left - GRIP - GAP,
          top: box.bottom + GAP,
          width: GRIP,
          height: GRIP + 6,
        }}
        onClick={() =>
          act(rowActions.insertAfter, Math.max(0, shape.rows - 1), 0)
        }
      />
    </div>,
    document.body,
  );
}

function Grip({
  kind,
  style,
  label,
  isHeader,
  headerLabel,
  insertBefore,
  insertAfter,
  remove,
  removable,
  onOpenChange,
  onInsertBefore,
  onInsertAfter,
  onRemove,
  onToggleHeader,
}: {
  kind: "row" | "column";
  style: React.CSSProperties;
  label: string;
  isHeader: boolean;
  headerLabel: string;
  insertBefore: string;
  insertAfter: string;
  remove: string;
  removable: boolean;
  onOpenChange: (open: boolean) => void;
  onInsertBefore: () => void;
  onInsertAfter: () => void;
  onRemove: () => void;
  onToggleHeader: () => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-table-grip={kind}
          style={style}
          // The grip takes the click without taking the caret: what is being
          // written keeps it, and the action puts the selection exactly
          // where it needs it.
          onMouseDown={(event) => event.preventDefault()}
          className="pointer-events-auto fixed bg-border transition-colors hover:bg-[#878787] focus-visible:bg-[#878787] focus-visible:outline-none"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onSelect={onInsertBefore}>
          {insertBefore}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onInsertAfter}>
          {insertAfter}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onToggleHeader}>
          {isHeader ? `Remove ${headerLabel.toLowerCase()}` : headerLabel}
        </DropdownMenuItem>
        {removable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRemove}>{remove}</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Add({
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
      className="pointer-events-auto fixed flex items-center justify-center bg-border text-primary transition-colors hover:bg-[#878787] focus-visible:bg-[#878787] focus-visible:outline-none"
    >
      <Plus className="size-2.5" />
    </button>
  );
}
