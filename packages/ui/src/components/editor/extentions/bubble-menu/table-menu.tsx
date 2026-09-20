"use client";

import { type Editor, BubbleMenu as TiptapBubbleMenu } from "@tiptap/react";
import type { Props as TippyOptions } from "tippy.js";
import { BubbleMenuButton } from "./bubble-menu-button";

/**
 * What a table can be changed into, while the caret is resting in one
 * (FF-1642).
 *
 * It floats, the way the marks menu does, and only while the caret is inside
 * a table — a table at rest is the grid and nothing else, with no handles
 * down its edges. Nothing on the page moves when it appears: it is drawn
 * over the document rather than in it.
 *
 * Written out rather than drawn: bold and italic have a glyph everyone
 * already reads, and "add a column to the right" does not.
 */
/** Where the table holding the caret is on screen. */
function tableRect(editor: Editor): DOMRect {
  const { from } = editor.state.selection;
  const at = editor.view.domAtPos(from).node;
  const el = at instanceof HTMLElement ? at : at.parentElement;
  return (
    el?.closest("table")?.getBoundingClientRect() ??
    // The caret left the table between the bar being shown and being
    // placed; an empty rect parks it rather than throwing.
    new DOMRect()
  );
}

export function TableMenu({
  editor,
  tippyOptions,
}: {
  editor: Editor;
  tippyOptions?: TippyOptions;
}) {
  const controls: { label: string; action: () => void }[] = [
    {
      label: "+ Row",
      action: () => editor.chain().focus().addRowAfter().run(),
    },
    {
      label: "+ Column",
      action: () => editor.chain().focus().addColumnAfter().run(),
    },
    { label: "− Row", action: () => editor.chain().focus().deleteRow().run() },
    {
      label: "− Column",
      action: () => editor.chain().focus().deleteColumn().run(),
    },
    {
      label: "Delete table",
      action: () => editor.chain().focus().deleteTable().run(),
    },
  ];

  return (
    <TiptapBubbleMenu
      editor={editor}
      pluginKey="table-menu"
      // Inside a table, and only while nothing is selected: the marks menu
      // takes over the moment there is a selection to mark up, so the two
      // never ask for the same spot.
      shouldShow={({ editor: current, state }) =>
        current.isEditable && current.isActive("table") && state.selection.empty
      }
      tippyOptions={{
        placement: "top-start",
        // Anchored to the table, not to the caret. Tippy's default reference
        // is the selection, which put the bar straight on top of the cell
        // being typed in — measured at 800px wide, it covered the whole
        // first column. Above the table it covers nothing anyone is
        // writing, and it is drawn over the document rather than in it, so
        // the page does not move when it appears.
        getReferenceClientRect: () => tableRect(editor),
        ...tippyOptions,
      }}
    >
      <div className="flex w-fit max-w-[90vw] overflow-hidden rounded-full border border-border bg-background text-mono font-regular">
        {controls.map((control) => (
          <BubbleMenuButton
            key={control.label}
            action={control.action}
            isActive={false}
          >
            {control.label}
          </BubbleMenuButton>
        ))}
      </div>
    </TiptapBubbleMenu>
  );
}
