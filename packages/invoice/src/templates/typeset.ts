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
  blockHeading: 1.95,
  /**
   * The step from a block's title down to a heading inside it is wider than
   * the steps below it — 1.34 against 1.21 (FF-1662). Those gaps are not
   * equal in meaning: a block's title names a section of the document, and
   * a heading inside it names a subsection of that section. Stepped evenly
   * they read as peers, which is what "Waarom dit nu nodig is" and
   * "Kernproblemen vandaag" were doing.
   */
  /**
   * The quote's own name, above every title a block can carry. It is the
   * one thing on the page that names the whole document.
   */
  documentTitle: 2.4,
  /** How far apart the lines of a paragraph sit, and of a heading. */
  leading: { body: 1.55, heading: 1.25 },
  /**
   * How wide a line of running text is allowed to run, as a multiple of the
   * body size — so one number sets the column on every surface (FF-1662).
   *
   * 42 is about 80 characters. It replaces 57, which is about 120: the
   * screen's 800px at 14px and the PDF's 515pt at 9pt were matched to each
   * other exactly, and both were half again longer than a line wants to be.
   * Matching them was right; the number they were matched at was not.
   *
   * This is the text column, not the page. A quote's pricing table carries
   * three fixed columns inside the page's full width, and narrowing the
   * page would leave its description column unreadable — so the running
   * text narrows on its own and the tables keep the page.
   */
  measure: 42,
  /**
   * What separates a level from the one below it, beyond size. Every
   * heading on both surfaces used to be one flat weight — 500 on screen and
   * 600 in the PDF, which did not even agree with each other — so the
   * hierarchy rested on size alone and read soft (FF-1662). One step, kept
   * small: this is a restrained design and a bolder jump would not belong.
   */
  weight: { body: 400, heading: 500, blockHeading: 600, documentTitle: 600 },
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

/** How wide running text may run at this body size. */
export function measureWidth(body: number): number {
  return body * TYPESET.measure;
}

/** Rounded to whole pixels, for the surfaces measured in them. */
export const px = (value: number) => Math.round(value);
