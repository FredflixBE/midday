// You can find the list of extensions here: https://tiptap.dev/docs/editor/extensions/functionality

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { type StoredImages, storedImage } from "./stored-image";

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
}) {
  const { placeholder, images } = options ?? {};
  return [
    ...extensions,
    storedImage(images),
    Placeholder.configure({ placeholder }),
  ];
}
