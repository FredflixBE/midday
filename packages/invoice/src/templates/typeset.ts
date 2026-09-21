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
   * A block's own title, which names the section its text belongs to. It is
   * drawn at what used to be an h1's size, because that is what it is — the
   * heading a block already has. Offering an h1 inside it as well gave a
   * block two titles trying to mean the same thing, so the slash menu now
   * offers a heading and a subheading under it rather than a second first
   * level (FF-1652).
   */
  blockHeading: 1.75,
  /**
   * The quote's own name, above every title a block can carry. It is the
   * one thing on the page that names the whole document.
   */
  documentTitle: 2.1,
  /** How far apart the lines of a paragraph sit, and of a heading. */
  leading: { body: 1.55, heading: 1.25 },
  /**
   * The space around a block, as a multiple of the body size. A heading
   * takes more above than below, so it belongs to what follows it rather
   * than floating between two things equally; a paragraph takes the same on
   * both sides, because it belongs to nothing but itself.
   *
   * Paragraphs had none at all, which is what made a written block read as
   * one grey slab with line breaks in it (FF-1652).
   */
  flow: { above: 1.1, below: 0.35, paragraph: 0.55 },
} as const;

/** A heading's size at this body size, for the level given. */
export function headingSize(body: number, level = 1): number {
  return body * (TYPESET.heading[level] ?? TYPESET.smallestHeading);
}

/** A block's own title at this body size. */
export function blockHeadingSize(body: number): number {
  return body * TYPESET.blockHeading;
}

/** The quote's own name at this body size. */
export function documentTitleSize(body: number): number {
  return body * TYPESET.documentTitle;
}

/** Rounded to whole pixels, for the surfaces measured in them. */
export const px = (value: number) => Math.round(value);
