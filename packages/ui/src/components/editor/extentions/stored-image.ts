import Image from "@tiptap/extension-image";

/**
 * A picture the editor holds by its place in storage, never by a public URL
 * (FF-1625): what is saved is the path under the team, and the address the
 * browser loads is made from it each time, so the picture cannot be reached
 * by guessing a link.
 */
export type StoredImages = {
  /** The address that shows a stored path, or null while it is unknown. */
  srcOf: (path: string) => string | null;
  /** Puts a file in storage and answers with the path it was stored under. */
  upload?: (file: File) => Promise<string>;
};

/**
 * Part of the schema wherever `registerExtensions` builds one, whether or not
 * pictures can be added there. Tiptap throws away nodes its schema does not
 * know, so an editor built without this would quietly strip the pictures out
 * of text it was only meant to show — and the next keystroke would save the
 * text without them.
 *
 * Being in the schema is not the same as taking one, though: an editor with
 * nowhere to store pictures parses none, so a picture copied out of a quote
 * cannot be pasted into a surface that would only lose it again.
 */
export function storedImage(images?: StoredImages) {
  return Image.extend({
    name: "image",
    // Alone on its line, and whole: a picture is not part of a sentence.
    inline: false,
    group: "block",

    addAttributes() {
      return {
        path: { default: null },
        alt: { default: null },
      };
    },

    // A picture arrives from the toolbar, which puts the file somewhere and
    // gets a path back. Tiptap's own `![alt](src)` shortcut would make one
    // out of an address instead — an address this node has nowhere to keep —
    // so it is dropped rather than left to insert an empty picture.
    addInputRules() {
      return [];
    },

    parseHTML() {
      return images ? [{ tag: "img[data-path]" }] : [];
    },

    renderHTML({ HTMLAttributes }) {
      const { path, alt } = HTMLAttributes as {
        path?: string | null;
        alt?: string | null;
      };
      return [
        "img",
        {
          "data-path": path ?? null,
          src: path ? (images?.srcOf(path) ?? null) : null,
          alt: alt ?? "",
        },
      ];
    },
  });
}
