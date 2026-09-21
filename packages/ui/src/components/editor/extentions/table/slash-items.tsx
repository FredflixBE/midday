"use client";

import type { Editor } from "@tiptap/react";
import { Table as TableIcon } from "lucide-react";
import type { SlashCommandItem } from "../slash-command/types";
import { columnActions, rowActions, tableAt } from "./commands";

/**
 * What a table can be changed into, offered on the slash menu while the
 * caret is inside one (FF-1642).
 *
 * The row and column handles are the ordinary way to do all of this, and
 * they are drawn where the pointer is — which means they cannot be reached
 * without one. Tab and Shift-Tab already move between cells, so the table is
 * writable from the keyboard; this is what makes it *changeable* from the
 * keyboard, by reusing the one menu that is already driven entirely by it.
 *
 * Only shown inside a table, so the ordinary slash menu is unchanged.
 */
export function tableSlashItems(editor: Editor): SlashCommandItem[] {
  if (!editor.isActive("table")) return [];

  // Which cell the caret is in, so these act where the person is rather
  // than on the first cell of the table.
  const at = () => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name !== "table") continue;
      const element = editor.view.nodeDOM($from.before(depth));
      if (!(element instanceof HTMLElement)) return null;
      const grid = element.closest("table") ?? element.querySelector("table");
      if (!grid) return null;
      const found = tableAt(editor, editor.view.dom as HTMLElement, grid);
      if (!found) return null;

      // The row and column the caret sits in, counted off the cell it is in.
      const cell = $from.node(depth + 2);
      const row = $from.node(depth + 1);
      let column = 0;
      let index = 0;
      row.forEach((child) => {
        if (child === cell) column = index;
        index++;
      });
      let rowIndex = 0;
      let seen = 0;
      found.node.forEach((child) => {
        if (child === row) rowIndex = seen;
        seen++;
      });
      return {
        editor,
        table: found.node,
        tablePos: found.pos,
        row: rowIndex,
        column,
      };
    }
    return null;
  };

  const run =
    (action: (ref: NonNullable<ReturnType<typeof at>>) => void) =>
    ({ range }: Parameters<SlashCommandItem["command"]>[0]) => {
      // What was typed goes first, and the cell is found afterwards: the
      // action is about the table, not about the "/row" still sitting in
      // the cell it was typed into.
      editor.chain().focus().deleteRange(range).run();
      const ref = at();
      if (ref) action(ref);
    };

  const icon = <TableIcon className="size-3.5" />;

  return [
    {
      id: "table-row-above",
      label: "Insert row above",
      icon,
      command: run(rowActions.insertBefore),
    },
    {
      id: "table-row-below",
      label: "Insert row below",
      icon,
      command: run(rowActions.insertAfter),
    },
    {
      id: "table-column-left",
      label: "Insert column left",
      icon,
      command: run(columnActions.insertBefore),
    },
    {
      id: "table-column-right",
      label: "Insert column right",
      icon,
      command: run(columnActions.insertAfter),
    },
    {
      id: "table-header-row",
      label: "Header row",
      icon,
      command: run(rowActions.toggleHeader),
    },
    {
      id: "table-header-column",
      label: "Header column",
      icon,
      command: run(columnActions.toggleHeader),
    },
    {
      id: "table-delete-row",
      label: "Delete row",
      icon,
      command: run(rowActions.remove),
    },
    {
      id: "table-delete-column",
      label: "Delete column",
      icon,
      command: run(columnActions.remove),
    },
    {
      id: "table-delete",
      label: "Delete table",
      icon,
      command: run(rowActions.removeTable),
    },
  ];
}
