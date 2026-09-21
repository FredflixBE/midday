/**
 * One reading rhythm per document, wherever that document is drawn
 * (FF-1651). There are two documents here, not one (FF-1663).
 *
 * The same text is drawn several ways — the editor on screen, the PDF the
 * client is sent, the web view, and the MCP preview — and only one of them
 * can read a stylesheet. react-pdf takes numbers, so a stylesheet cannot be
 * the source of the sizes; this is.
 *
 * Both scales follow the three controls a typeset is usually reduced to: a
 * base size, a leading, and a flow — the space between blocks. Everything
 * else, every heading size and the room around it, is a multiple of the
 * base, so each surface says only how big its own body text is and the rest
 * follows. That is what keeps the screen reading as the print reads: not
 * copies of the same numbers kept in step by hand, but one set of
 * proportions and one base size per surface.
 */

/** What a document's rhythm is made of. */
export type Typeset = {
  /**
   * A heading's size, as a multiple of the body size. Levels past the third
   * read alike: past that, a document wants a new section rather than a
   * smaller heading.
   */
  heading: Record<number, number>;
  smallestHeading: number;
  /** How far apart the lines of a paragraph sit, and of a heading. */
  leading: { body: number; heading: number };
  /** What separates a level from the one below it, beyond size. */
  weight: { body: number; heading: number };
  /**
   * The space above a block, as a multiple of the body size. Above only:
   * spacing flows one way, which is shadcn/typeset's own rule and the reason
   * two margins never meet (FF-1665). `below` is the room a heading owns
   * beneath it, taken by whatever follows; `item` is the gap between the
   * items of a list, which is not the gap between paragraphs.
   */
  flow: { above: number; below: number; paragraph: number; item: number };
};

/**
 * An invoice's, which is every surface but a quote's: the invoice PDF, the
 * public invoice view, and the MCP preview.
 *
 * An invoice's rich text is a note at the foot of a page and a pair of
 * address blocks — a few lines, not a document — so it keeps the tight
 * rhythm it has always had. It was a quote that outgrew this (FF-1663), and
 * loosening an invoice to suit a quote is the mistake FF-1661 already made
 * once with the marketplace panels.
 *
 * The steps are what they are on purpose. The scale they replaced stepped
 * 1.11, 1.33 and 1.56 from the body, and a heading 11% larger than the text
 * under it is not a heading — it is body text someone made bold.
 */
export const TYPESET: Typeset = {
  heading: { 1: 1.75, 2: 1.45, 3: 1.2 },
  smallestHeading: 1.2,
  leading: { body: 1.55, heading: 1.25 },
  weight: { body: 400, heading: 500 },
  /** A list's items sit flush, which is what an invoice note draws today. */
  flow: { above: 1.1, below: 0.35, paragraph: 0.55, item: 0 },
};

/**
 * A quote's, which is **shadcn/typeset's** (FF-1663).
 *
 * Every number here is transcribed from `apps/dashboard/src/styles/
 * typeset.css`, the stylesheet that sets the quote on screen. It has to be
 * transcribed rather than read, because react-pdf cannot read a stylesheet
 * — and `typeset.test.ts` is what proves the transcription still matches,
 * including after a newer `typeset.css` is pulled down.
 *
 * Why theirs rather than ours: the scale above was reasoned out a ticket at
 * a time — FF-1651 set the steps, FF-1652 added the paragraph flow, FF-1662
 * fixed the weights — each fixing a real complaint, none of it designed as
 * a whole. This was. The one deliberate decision it overwrites is FF-1652's
 * "a heading belongs to what follows it, so it takes more room above than
 * below"; shadcn's designers chose the opposite and it reads well.
 */
export const QUOTE_TYPESET = {
  /** `h1 1.75em`, `h2 1.25em`, `h3 1.125em`, `h4 1em`. */
  heading: { 1: 1.75, 2: 1.25, 3: 1.125 } as Record<number, number>,
  smallestHeading: 1,
  /**
   * `--typeset-leading: 1.75`, and one heading leading because react-pdf
   * takes one number. Upstream sets three — 1.3, 1.4 and 1.45 for the first
   * three levels — and 1.4 is the middle of them and the one a quote's
   * commonest heading uses.
   */
  leading: { body: 1.75, heading: 1.4 },
  /** `h1`–`h4` are 600 there; a block's own title and the document's stay
      at 600 too, which is what they already were. */
  weight: { body: 400, heading: 600, blockHeading: 600, documentTitle: 600 },
  /**
   * `--typeset-flow: 1.25em`, which is the room above a paragraph and above
   * a heading alike, and `1em` below a heading — upstream's "headings own
   * the space below them".
   *
   * `item` is `li { margin-block-start: 0.5em }` — a list's items sit closer
   * together than paragraphs do, and a bullet spaced like a paragraph is
   * what made the print read loose against the screen (FF-1665).
   *
   * Upstream gives an `h2` 1.4× the flow above it rather than the flow, a
   * step one number cannot carry. The screen takes it because the screen
   * reads the stylesheet; the print gives every level the same room above.
   */
  flow: { above: 1.25, below: 1, paragraph: 1.25, item: 0.5 },
  /**
   * A block's own title, which names the section its text belongs to. Drawn
   * at what used to be an h1's size, because that is what it is — the
   * heading a block already has. Offering an h1 inside it as well gave a
   * block two titles trying to mean the same thing, so the slash menu offers
   * a heading and a subheading under it instead (FF-1652).
   *
   * Ours, not upstream's: a markdown page has no such thing.
   */
  blockHeading: 1.95,
  /**
   * The quote's own name, above every title a block can carry. It is the
   * one thing on the page that names the whole document. Ours as well.
   */
  documentTitle: 2.4,
  /**
   * How wide a line of running text runs on a **page**, as a multiple of
   * the body size (FF-1662). 42 is about 80 characters, where the PDF's
   * 515pt of 9pt text ran 57em — about 120.
   *
   * A page only. The screen is not bound to this and deliberately so: the
   * two used to be matched exactly, so that a line broke on screen where it
   * breaks in print, and the cost was a browser column half as wide as the
   * window it sits in. A page is fixed and a window is not.
   *
   * This is the text column, not the page itself. A quote's pricing table
   * carries three fixed columns inside the page's full width, and narrowing
   * the page would leave its description column unreadable — so the running
   * text narrows on its own and the tables keep the page.
   *
   * Upstream leaves measure to the layout for the same reason, so this is
   * ours by their design as much as by ours.
   *
   * 32, not the 42 FF-1662 set: the page has a sidehead column down its
   * left now (FF-1666), and the text column is what is left of the page
   * beside it. 42em ran about 80 characters, at the top of the comfortable
   * band; this runs about 61, in the middle of it. The column got narrower
   * and the page stopped being lopsided in the same move.
   *
   * What settled on 32 rather than 34 is the other column: at 34 the
   * sidehead was 184pt and "Waarom dit nu nodig is" is 193pt, so it broke
   * with "is" alone on a line. A title is the thing in a sidehead, and a
   * one-word widow in it is the first thing you see.
   */
  measure: 32,
} as const;

/** A heading's size at this body size, for the level given. */
export function headingSize(
  body: number,
  level = 1,
  scale: Pick<Typeset, "heading" | "smallestHeading"> = TYPESET,
): number {
  return body * (scale.heading[level] ?? scale.smallestHeading);
}

/** A block's own title at this body size. A quote has these; nothing else does. */
export function blockHeadingSize(body: number): number {
  return body * QUOTE_TYPESET.blockHeading;
}

/** The quote's own name at this body size. */
export function documentTitleSize(body: number): number {
  return body * QUOTE_TYPESET.documentTitle;
}

/** How wide a quote's running text may run at this body size. */
export function measureWidth(body: number): number {
  return body * QUOTE_TYPESET.measure;
}

/** Rounded to whole pixels, for the surfaces measured in them. */
export const px = (value: number) => Math.round(value);
