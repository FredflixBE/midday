// You can find the list of extensions here: https://tiptap.dev/docs/editor/extensions/functionality

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import type { Extensions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type StoredImages, storedImage } from "./stored-image";
import { tableExtensions } from "./table";

// Add your extensions here
const extensions = [
  StarterKit,
  Underline,
  Link.configure({
    openOnClick: false,
    autolink: true,
    defaultProtocol: "https",
  }),
];

export function registerExtensions(options?: {
  placeholder?: string;
  /** Where the editor's pictures are stored and shown from. */
  images?: StoredImages;
  /** Anything the caller adds, such as the slash menu (FF-1638). */
  extra?: Extensions;
}) {
  const { placeholder, images, extra } = options ?? {};
  return [
    ...extensions,
    storedImage(images),
    ...tableExtensions,
    // On every empty node, not only the one the caret is in: an untouched
    // block has to say how to start before it is clicked into (FF-1638).
    // What is drawn from it is the caller's CSS.
    Placeholder.configure({ placeholder, showOnlyCurrent: false }),
    ...(extra ?? []),
  ];
}
