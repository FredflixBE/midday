"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "../../../use-toast";
import type { StoredImages } from "../stored-image";
import { SlashCommand } from ".";
import { filterSlashCommands, slashCommandItems } from "./items";
import { SlashMenu, type SlashMenuRef } from "./slash-menu";
import type { SlashCommandItem } from "./types";

/**
 * Typing `/` offers what a block can hold, the way Notion does (FF-1638).
 *
 * The menu is rendered from React rather than from inside the ProseMirror
 * plugin, so it keeps the app's toast and theme and there is only ever one
 * React root. The plugin reports where the caret is and hands the keystrokes
 * over; everything else happens here.
 */
export function useSlashCommand({
  enabled,
  images,
}: {
  enabled: boolean;
  images?: StoredImages;
}) {
  const { toast } = useToast();
  // The menu is drawn into the body, which only exists in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const file = useRef<HTMLInputElement>(null);
  // The editor the picture was asked for from: the file dialog answers long
  // after the menu that opened it has gone.
  const waiting = useRef<Editor | null>(null);
  const menu = useRef<SlashMenuRef>(null);

  const box = useRef<HTMLDivElement>(null);
  // Dismissed by hand: the suggestion is still running, so without this the
  // next keystroke would put the menu straight back.
  const dismissed = useRef(false);
  const [open, setOpen] = useState<{
    items: SlashCommandItem[];
    /** Where the caret is, asked again whenever anything moves. */
    caret: () => DOMRect | null;
    run: (item: SlashCommandItem) => void;
  } | null>(null);

  // Escape closes the menu and nothing else. A listener on the window in the
  // capture phase runs before Radix's on the document, which is the only
  // place to stop the full-screen dialog (FF-1624) closing along with it.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissed.current = true;
      setOpen(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open]);

  // Beside the caret, above it where there is no room below, and never off
  // the right edge. Asked again on every scroll — including a scroll inside
  // the full-screen dialog, which the page's own scroll would not catch.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = box.current;
      const at = open.caret();
      if (!el || !at) return;
      const below = at.bottom + 4 + el.offsetHeight <= window.innerHeight;
      el.style.top = `${(below ? at.bottom + 4 : at.top - 4 - el.offsetHeight) + window.scrollY}px`;
      el.style.left = `${Math.max(0, Math.min(at.left, window.innerWidth - el.offsetWidth - 8)) + window.scrollX}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const items = useMemo(
    () =>
      slashCommandItems({
        pickImage: images?.upload
          ? () => {
              file.current?.click();
            }
          : undefined,
      }),
    [images?.upload],
  );

  const extension = useMemo(() => {
    if (!enabled) return null;
    return SlashCommand.configure({
      suggestion: {
        items: ({ query }) => filterSlashCommands(items, query),
        render: () => {
          const show = (props: {
            items: SlashCommandItem[];
            command: (item: SlashCommandItem) => void;
            clientRect?: (() => DOMRect | null) | null;
            editor: Editor;
          }) => {
            const caret = props.clientRect;
            // Nothing matches what was typed: no empty box, and nothing to
            // hand the keystrokes to, so Enter still ends the line.
            if (!caret || props.items.length === 0 || dismissed.current) {
              setOpen(null);
              return;
            }
            waiting.current = props.editor;
            setOpen({ items: props.items, run: props.command, caret });
          };
          return {
            onStart: show,
            onUpdate: show,
            // Escape is not handled here: Radix listens for it on the
            // document in the capture phase, so by the time ProseMirror is
            // asked the dialog holding this editor has already closed. It is
            // taken on the window instead, below.
            onKeyDown: ({ event }) =>
              event.key === "Escape"
                ? false
                : (menu.current?.onKeyDown({ event }) ?? false),
            onExit: () => {
              dismissed.current = false;
              setOpen(null);
            },
          };
        },
      },
    });
  }, [enabled, items]);

  const add = async (chosen: File) => {
    const editor = waiting.current;
    if (!editor || !images?.upload) return;
    try {
      const path = await images.upload(chosen);
      editor
        .chain()
        .focus()
        .insertContent({ type: "image", attrs: { path, alt: chosen.name } })
        .run();
    } catch (error) {
      // The picture is not in the text and nothing on screen moved: saying
      // nothing would read as nothing having happened.
      toast({
        title: "The picture was not added",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "error",
      });
    }
  };

  const overlay = !(enabled && mounted)
    ? null
    : createPortal(
        <>
          {open ? (
            // `pointer-events` because a Radix modal turns them off on the
            // body, and the menu is drawn there rather than inside it.
            <div ref={box} className="pointer-events-auto absolute z-50">
              <SlashMenu
                ref={menu}
                items={open.items}
                command={(item) => open.run(item as SlashCommandItem)}
              />
            </div>
          ) : null}
          {images?.upload ? (
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = "";
                if (chosen) void add(chosen);
              }}
            />
          ) : null}
        </>,
        document.body,
      );

  return { extension, overlay };
}
