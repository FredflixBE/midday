/**
 * One reading rhythm for a document, wherever it is drawn (FF-1651).
 *
 * The same text is drawn four ways — the editor on screen, the PDF the
 * client is sent, the web view, and the MCP preview — and only one of them
 * can read a stylesheet. react-pdf takes numbers, so a stylesheet cannot be
 * the source of the sizes; this is.
 *
 * It follows the three controls a typeset is usually reduced to: a base
 * size, a leading, and a flow — the space between blocks. Everything else,
 * every heading size and the room around it, is a multiple of the base, so
 * each surface says only how big its own body text is and the rest follows.
 * That is what keeps the screen reading as the print reads: not four copies
 * of the same numbers kept in step by hand, but one set of proportions and
 * four base sizes.
 *
 * The steps are what they are on purpose. The scale they replaced stepped
 * 1.11, 1.33 and 1.56 from the body, and a heading 11% larger than the text
 * under it is not a heading — it is body text someone made bold.
 */
export const TYPESET = {
  /**
   * A heading's size, as a multiple of the body size. Levels 3 and below
   * read alike: past the third, a document wants a new section rather than
   * a smaller heading.
   */
  heading: { 1: 1.75, 2: 1.45, 3: 1.2 } as Record<number, number>,
  smallestHeading: 1.2,
  /**
   * A block's own title, which sits above every heading its text can hold.
   * It used to be drawn at exactly an h1's size, in the editor and in the
   * PDF alike, so a section's title and a heading inside it were the same
   * thing to look at.
   */
  blockHeading: 2.1,
  /** How far apart the lines of a paragraph sit, and of a heading. */
  leading: { body: 1.55, heading: 1.25 },
  /**
   * The space around a heading, as a multiple of the body size. More above
   * than below, so a heading belongs to what follows it rather than
   * floating between two things equally.
   */
  flow: { above: 1.1, below: 0.35 },
} as const;

/** A heading's size at this body size, for the level given. */
export function headingSize(body: number, level = 1): number {
  return body * (TYPESET.heading[level] ?? TYPESET.smallestHeading);
}

/** A block's own title at this body size. */
export function blockHeadingSize(body: number): number {
  return body * TYPESET.blockHeading;
}

/** Rounded to whole pixels, for the surfaces measured in them. */
export const px = (value: number) => Math.round(value);
