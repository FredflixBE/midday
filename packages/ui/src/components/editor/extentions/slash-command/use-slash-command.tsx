"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "../../../use-toast";
import type { StoredImages } from "../stored-image";
import { SlashCommand } from ".";
import { filterSlashCommands, slashCommandItems } from "./items";
import { SlashMenu, type SlashMenuRef } from "./slash-menu";
import type { SlashCommandItem } from "./types";

type At = { left: number; top: number };

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

  const [open, setOpen] = useState<{
    items: SlashCommandItem[];
    at: At;
    run: (item: SlashCommandItem) => void;
  } | null>(null);

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
            const rect = props.clientRect?.();
            if (!rect) return;
            waiting.current = props.editor;
            setOpen({
              items: props.items,
              run: props.command,
              at: {
                left: rect.left + window.scrollX,
                top: rect.bottom + window.scrollY + 4,
              },
            });
          };
          return {
            onStart: show,
            onUpdate: show,
            onKeyDown: ({ event }) => {
              if (event.key === "Escape") {
                setOpen(null);
                return true;
              }
              return menu.current?.onKeyDown({ event }) ?? false;
            },
            onExit: () => setOpen(null),
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
            <div
              className="absolute z-50"
              style={{ left: open.at.left, top: open.at.top }}
            >
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
