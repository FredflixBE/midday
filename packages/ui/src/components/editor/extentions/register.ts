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
  /** Given, the editor also holds pictures. */
  images?: StoredImages;
}) {
  const { placeholder, images } = options ?? {};
  return [
    ...extensions,
    ...(images ? [storedImage(images)] : []),
    Placeholder.configure({ placeholder }),
  ];
}
