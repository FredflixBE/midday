// You can find the list of extensions here: https://tiptap.dev/docs/editor/extensions/functionality

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import type { Extensions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { diagram } from "./diagram";
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
  /** True where a diagram may be written here, not only shown (FF-1643). */
  diagrams?: boolean;
  /** Anything the caller adds, such as the slash menu (FF-1638). */
  extra?: Extensions;
}) {
  const { placeholder, images, diagrams, extra } = options ?? {};
  return [
    ...extensions,
    storedImage(images),
    ...tableExtensions,
    // Always in the schema; only the quote document may write one.
    diagram({ images, canEdit: Boolean(diagrams) }),
    // On the node the caret is in and no other (FF-1649). FF-1638 put it on
    // every empty node, so an untouched block would say how to start before
    // it was clicked into; in a document of several blocks that reads as a
    // column of repeated instructions. What is drawn from it is the
    // caller's CSS, which also asks for focus.
    Placeholder.configure({ placeholder, showOnlyCurrent: true }),
    ...(extra ?? []),
  ];
}
