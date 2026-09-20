"use client";

import type { Editor } from "@tiptap/react";
import { Heading1, Heading2, Heading3 } from "lucide-react";
import { useState } from "react";
import {
  MdOutlineFormatBold,
  MdOutlineFormatItalic,
  MdOutlineFormatListBulleted,
  MdOutlineFormatListNumbered,
  MdOutlineFormatStrikethrough,
  MdOutlineFormatUnderlined,
} from "react-icons/md";
import { cn } from "../../../../utils";
import { Separator } from "../../../separator";
import { BubbleMenuItem } from "../bubble-menu/bubble-item";
import { LinkItem } from "../bubble-menu/link-item";
import type { StoredImages } from "../stored-image";
import { ImageItem } from "./image-item";

/**
 * The formatting a text block offers without knowing a markdown shortcut
 * (FF-1623). Off by default on the shared editor: the invoice blocks are a
 * few lines of address text and want no chrome above them.
 */
export function Toolbar({
  editor,
  images,
  className,
}: {
  editor: Editor;
  images?: StoredImages;
  /** Where the toolbar sits, for a caller that does not want it in flow. */
  className?: string;
}) {
  const [openLink, setOpenLink] = useState(false);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center border-b border-border px-1 py-0.5",
        className,
      )}
    >
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

      <Divider />

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleBulletList().run()}
        isActive={editor.isActive("bulletList")}
      >
        <MdOutlineFormatListBulleted className="size-4" />
        <span className="sr-only">Bullet list</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleOrderedList().run()}
        isActive={editor.isActive("orderedList")}
      >
        <MdOutlineFormatListNumbered className="size-4" />
        <span className="sr-only">Numbered list</span>
      </BubbleMenuItem>

      <Divider />

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive("bold")}
      >
        <MdOutlineFormatBold className="size-4" />
        <span className="sr-only">Bold</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive("italic")}
      >
        <MdOutlineFormatItalic className="size-4" />
        <span className="sr-only">Italic</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleUnderline().run()}
        isActive={editor.isActive("underline")}
      >
        <MdOutlineFormatUnderlined className="size-4" />
        <span className="sr-only">Underline</span>
      </BubbleMenuItem>

      <BubbleMenuItem
        editor={editor}
        action={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive("strike")}
      >
        <MdOutlineFormatStrikethrough className="size-4" />
        <span className="sr-only">Strike</span>
      </BubbleMenuItem>

      <Divider />

      <LinkItem editor={editor} open={openLink} setOpen={setOpenLink} />

      {images?.upload ? (
        <ImageItem editor={editor} upload={images.upload} />
      ) : null}
    </div>
  );
}

function Divider() {
  return <Separator orientation="vertical" className="mx-1 h-4" />;
}
