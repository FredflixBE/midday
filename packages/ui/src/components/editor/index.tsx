"use client";

import "./styles.css";

import {
  EditorContent,
  type Editor as EditorInstance,
  type JSONContent,
  useEditor,
} from "@tiptap/react";
import { BubbleMenu } from "./extentions/bubble-menu";
import { TableMenu } from "./extentions/bubble-menu/table-menu";
import { registerExtensions } from "./extentions/register";
import { useSlashCommand } from "./extentions/slash-command/use-slash-command";
import type { StoredImages } from "./extentions/stored-image";

export type { StoredImages };

import { Toolbar } from "./extentions/toolbar";

type EditorProps = {
  initialContent?: JSONContent | string;
  placeholder?: string;
  onUpdate?: (editor: EditorInstance) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  className?: string;
  tabIndex?: number;
  /** False shows the content without letting it be changed. */
  editable?: boolean;
  /**
   * Shows a toolbar above the text: headings, lists and inline marks. Off by
   * default, and never shown on content that cannot be changed.
   */
  toolbar?: boolean;
  /**
   * Typing "/" offers what a block can hold — headings, lists, a picture
   * (FF-1638). Off by default, and never on content that cannot be changed.
   */
  slashMenu?: boolean;
  /** True puts the caret at the end of the text as soon as it is mounted. */
  autoFocus?: boolean;
  /**
   * Given, the text may hold pictures: each is kept as a path in storage, and
   * the toolbar offers to add one when the pictures can also be uploaded.
   */
  images?: StoredImages;
  /**
   * True lets a table be written here (FF-1642): `/table` offers one, and a
   * bar of row and column controls floats while the caret is inside it. A
   * table already in the text is shown either way — the schema always knows
   * the node, so no surface can strip one out.
   */
  tables?: boolean;
};

export function Editor({
  initialContent,
  placeholder,
  onUpdate,
  onBlur,
  onFocus,
  className,
  tabIndex,
  editable = true,
  toolbar = false,
  slashMenu = false,
  autoFocus = false,
  images,
  tables = false,
}: EditorProps) {
  const slash = useSlashCommand({
    enabled: slashMenu && editable,
    images,
    tables: tables && editable,
  });

  const editor = useEditor({
    extensions: registerExtensions({
      placeholder,
      images,
      extra: slash.extension ? [slash.extension] : undefined,
    }),
    content: initialContent,
    immediatelyRender: false,
    editable,
    autofocus: autoFocus && editable ? "end" : false,
    onBlur,
    onFocus,
    onUpdate: ({ editor }) => {
      onUpdate?.(editor);
    },
  });

  if (!editor) return null;

  return (
    <>
      {toolbar && editable ? <Toolbar editor={editor} images={images} /> : null}
      <EditorContent
        editor={editor}
        className={className}
        tabIndex={tabIndex}
      />
      <BubbleMenu editor={editor} />
      {tables && editable ? <TableMenu editor={editor} /> : null}
      {slash.overlay}
    </>
  );
}
