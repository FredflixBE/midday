"use client";

import {
  imagePathsIn,
  isPendingImage,
  PENDING_IMAGE,
  type QuoteContent,
  replaceImagePaths,
} from "@midday/quote";
import { uploadToQuotes } from "./upload-to-quotes";

/**
 * The pictures this browser is holding for a quote it has not saved yet
 * (FF-1634).
 *
 * A picture used to be stored the moment it was picked or drawn, while the
 * path only reached a version's text on the next draft save. Close the tab
 * in between and no save ever held that path, so the FF-1626 cleanup — which
 * only ever considers paths a version's text once held — could never see the
 * file, and it stayed for good. A diagram made that easy to hit: every Save
 * in its dialog stored another PNG while the one before it was still only in
 * an unsaved draft.
 *
 * So nothing is stored until the draft that names it is saved. Until then
 * the text carries a stand-in and the picture is shown from memory.
 *
 * The store is a module's own rather than a hook's because the two ends sit
 * in different components — the editor picks the picture, the draft saves it
 * — and each stand-in is unique, so there is nothing for two editors open at
 * once to collide over.
 */
type Held = {
  file: File;
  /** What the editor shows it from before it is stored. */
  url: string;
  /** Set once, the first time it is stored, so a retry does not store it twice. */
  stored?: Promise<string>;
};

const held = new Map<string, Held>();

/** Takes a picture in and gives back the stand-in the text will carry. */
export function holdImage(file: File): string {
  const path = `${PENDING_IMAGE}${crypto.randomUUID()}`;
  held.set(path, { file, url: URL.createObjectURL(file) });
  return path;
}

/** Where a picture still in memory is shown from, or null if it is stored. */
export function heldImageUrl(path: string): string | null {
  return held.get(path)?.url ?? null;
}

/**
 * Stores every picture this content is still holding and gives the content
 * back with the stored paths in their place. Called on the way to the
 * server, so what is saved never names a picture nobody else can read.
 *
 * It throws rather than saving a stand-in: content naming a picture that
 * cannot be read would draw an empty space in the PDF and say nothing, and a
 * refused save is retried and then reported (FF-1648).
 */
export async function storeHeldImages(
  teamId: string,
  content: QuoteContent,
): Promise<QuoteContent> {
  const pending = imagePathsIn(content).filter(isPendingImage);
  if (pending.length === 0) return content;

  const stored: Record<string, string> = {};

  await Promise.all(
    pending.map(async (path) => {
      const picture = held.get(path);
      if (!picture) {
        throw new Error(
          "A picture in this quote is no longer in this browser. Take it out and add it again.",
        );
      }

      if (!picture.stored) {
        picture.stored = uploadToQuotes(teamId, picture.file, "images").then(
          (tokens) => tokens.join("/"),
        );
        // A refused upload must be attempted again by the next save, so the
        // promise is not kept once it is known to have failed.
        picture.stored.catch(() => {
          picture.stored = undefined;
        });
      }

      stored[path] = await picture.stored;
    }),
  );

  return replaceImagePaths(content, stored);
}
