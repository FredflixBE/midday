"use client";

import type { Editor } from "@tiptap/react";
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Strikethrough,
  Underline,
} from "lucide-react";
import { useState } from "react";
import { BubbleMenuItem } from "../bubble-menu/bubble-item";
import { LinkItem } from "../bubble-menu/link-item";

/**
 * The formatting a text block offers without knowing a markdown shortcut
 * (FF-1623). Off by default on the shared editor: the invoice blocks are a
 * few lines of address text and want no chrome above them.
 */
export function Toolbar({ editor }: { editor: Editor }) {
  const [openLink, setOpenLink] = useState(false);

  return (
    <div className="flex flex-wrap items-center border-b border-border px-1 py-0.5">
      {([1, 2, 3] as const).map((level) => {
        const Icon = { 1: Heading1, 2: Heading2, 3: Heading3 }[level];
        return (
          <BubbleMenuItem
            key={level}
            editor={editor}
            action={() => editor.chain().focus().toggleHeading({ level }).run()}
            isActive={editor.isActive("heading", { level })}
          >
            <Icon className="size-4" />
            <span className="sr-only">Heading {level}</span>
          </BubbleMenuItem>
        );
      })}

      <Separator />

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleBulletList().run()}
        isActive={editor.isActive("bulletList")}
      >
        <List className="size-4" />
        <span className="sr-only">Bullet list</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleOrderedList().run()}
        isActive={editor.isActive("orderedList")}
      >
        <ListOrdered className="size-4" />
        <span className="sr-only">Numbered list</span>
      </BubbleMenuItem>

      <Separator />

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive("bold")}
      >
        <Bold className="size-4" />
        <span className="sr-only">Bold</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive("italic")}
      >
        <Italic className="size-4" />
        <span className="sr-only">Italic</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleUnderline().run()}
        isActive={editor.isActive("underline")}
      >
        <Underline className="size-4" />
        <span className="sr-only">Underline</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive("strike")}
      >
        <Strikethrough className="size-4" />
        <span className="sr-only">Strike</span>
      </BubbleMenuItem>

      <Separator />

      <LinkItem editor={editor} open={openLink} setOpen={setOpenLink} />
    </div>
  );
}

function Separator() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}
