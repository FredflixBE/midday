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

export function storedImage(images: StoredImages) {
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

    parseHTML() {
      return [{ tag: "img[data-path]" }];
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
          src: path ? images.srcOf(path) : null,
          alt: alt ?? "",
        },
      ];
    },
  });
}
