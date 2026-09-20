"use client";

import "./styles.css";

import {
  EditorContent,
  type Editor as EditorInstance,
  type JSONContent,
  useEditor,
} from "@tiptap/react";
import { BubbleMenu } from "./extentions/bubble-menu";
import { registerExtensions } from "./extentions/register";
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
  /** Where the toolbar sits, for a caller that does not want it in flow. */
  toolbarClassName?: string;
  /** True puts the caret at the end of the text as soon as it is mounted. */
  autoFocus?: boolean;
  /**
   * Given, the text may hold pictures: each is kept as a path in storage, and
   * the toolbar offers to add one when the pictures can also be uploaded.
   */
  images?: StoredImages;
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
  toolbarClassName,
  autoFocus = false,
  images,
}: EditorProps) {
  const editor = useEditor({
    extensions: registerExtensions({ placeholder, images }),
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
      {toolbar && editable ? (
        <Toolbar editor={editor} images={images} className={toolbarClassName} />
      ) : null}
      <EditorContent
        editor={editor}
        className={className}
        tabIndex={tabIndex}
      />
      <BubbleMenu editor={editor} />
    </>
  );
}
