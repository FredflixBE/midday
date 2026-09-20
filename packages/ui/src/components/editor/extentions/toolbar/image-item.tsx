"use client";

import type { Editor } from "@tiptap/react";
import { useRef, useState } from "react";
import { MdOutlineImage } from "react-icons/md";
import { useToast } from "../../../use-toast";
import { BubbleMenuButton } from "../bubble-menu/bubble-menu-button";

/**
 * Adds a picture from the machine (FF-1625). The file goes to storage first;
 * what lands in the text is the path it was stored under, so the document
 * stays small and the picture is only reachable through the team's own key.
 */
export function ImageItem({
  editor,
  upload,
}: {
  editor: Editor;
  upload: (file: File) => Promise<string>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const add = async (file: File) => {
    setBusy(true);
    try {
      const path = await upload(file);
      editor
        .chain()
        .focus()
        .insertContent({ type: "image", attrs: { path, alt: file.name } })
        .run();
    } catch (error) {
      // Whatever went wrong, the picture is not in the text and the button
      // has stopped looking busy: saying nothing would read as nothing
      // happening.
      toast({
        title: "The picture was not added",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BubbleMenuButton
        isActive={false}
        className={busy ? "pointer-events-none opacity-50" : undefined}
        action={() => input.current?.click()}
      >
        <MdOutlineImage className="size-4" />
        <span className="sr-only">Image</span>
      </BubbleMenuButton>
      <input
        ref={input}
        type="file"
        // Only what the PDF can draw, so nothing is offered that it loses.
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Clear it, so picking the same file again still fires a change.
          event.target.value = "";
          if (file) void add(file);
        }}
      />
    </>
  );
}
