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
}: EditorProps) {
  const editor = useEditor({
    extensions: registerExtensions({ placeholder }),
    content: initialContent,
    immediatelyRender: false,
    editable,
    onBlur,
    onFocus,
    onUpdate: ({ editor }) => {
      onUpdate?.(editor);
    },
  });

  if (!editor) return null;

  return (
    <>
      {toolbar && editable ? <Toolbar editor={editor} /> : null}
      <EditorContent
        editor={editor}
        className={className}
        tabIndex={tabIndex}
      />
      <BubbleMenu editor={editor} />
    </>
  );
}
