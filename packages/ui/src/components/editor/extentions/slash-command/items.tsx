"use client";

import {
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  Table,
  Text,
  Workflow,
} from "lucide-react";
import type { SlashCommandItem } from "./types";

const HEADING_ICONS = {
  1: <Heading1 className="size-3.5" />,
  2: <Heading2 className="size-3.5" />,
  3: <Heading3 className="size-3.5" />,
};

/**
 * What `/` offers (FF-1638). Only what every renderer draws — the editor, the
 * PDF through `formatEditorContent`, and the web view — so nothing can be
 * written here that the client would never see. A picture is offered only
 * where there is somewhere to store one, a table only where one may be
 * written (FF-1642), and a diagram likewise (FF-1643).
 */
export function slashCommandItems(options?: {
  pickImage?: () => void;
  tables?: boolean;
  diagrams?: boolean;
}): SlashCommandItem[] {
  const items: SlashCommandItem[] = [
    {
      id: "paragraph",
      label: "Text",
      icon: <Text className="size-3.5" />,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setParagraph().run(),
    },
    ...([1, 2, 3] as const).map((level) => ({
      id: `heading-${level}`,
      label: `Heading ${level}`,
      icon: HEADING_ICONS[level],
      command: ({
        editor,
        range,
      }: Parameters<SlashCommandItem["command"]>[0]) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level })
          .run(),
    })),
    {
      id: "bullet-list",
      label: "Bulleted list",
      icon: <List className="size-3.5" />,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      id: "ordered-list",
      label: "Numbered list",
      icon: <ListOrdered className="size-3.5" />,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
  ];

  const { pickImage, tables, diagrams } = options ?? {};
  if (diagrams) {
    items.push({
      id: "diagram",
      label: "Diagram",
      icon: <Workflow className="size-3.5" />,
      // Empty: a diagram is written in mermaid in its own dialog, not in the
      // line the "/" was typed on, and the empty box it leaves is what opens
      // that dialog.
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({ type: "diagram", attrs: { source: "", path: null } })
          .run(),
    });
  }

  if (tables) {
    items.push({
      id: "table",
      label: "Table",
      icon: <Table className="size-3.5" />,
      // Three columns with a header row: enough to be a comparison table
      // straight away, and rows and columns are added from the bar that
      // shows while the caret is inside it.
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    });
  }

  if (pickImage) {
    items.push({
      id: "image",
      label: "Picture",
      icon: <ImageIcon className="size-3.5" />,
      // The "/" goes before the file dialog opens: it takes the focus, and
      // the typed text would otherwise still be sitting there when the
      // picture lands beside it.
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        pickImage();
      },
    });
  }

  return items;
}

/** The items the typed query names, in the order they are offered. */
export function filterSlashCommands(
  items: SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return items;
  return items.filter((item) => item.label.toLowerCase().includes(wanted));
}
