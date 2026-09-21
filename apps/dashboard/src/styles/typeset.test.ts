/**
 * The quote is set twice: on screen by `typeset.css`, and in print by
 * `QUOTE_TYPESET`, because react-pdf takes numbers and can read no
 * stylesheet (FF-1663).
 *
 * That is one rhythm written in two places, which is exactly the thing that
 * drifts. This reads the stylesheet and checks the scale still says what it
 * says — so a newer `typeset.css` pulled down from
 * https://ui.shadcn.com/typeset.css fails here rather than silently parting
 * the editor from the print.
 *
 * It reads only upstream's half of the file. Our preset below the marked
 * line sets the three controls and nothing else, by design.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QUOTE_TYPESET } from "@midday/invoice/templates/typeset";

const CSS = readFileSync(new URL("./typeset.css", import.meta.url), "utf8");

const upstream = CSS.slice(0, CSS.indexOf("Ours. Nothing above this line is."));

/** The value of one declaration inside the rule for `selector`. */
function declared(selector: string, property: string): string {
  const rule = upstream.slice(upstream.indexOf(`&:where(${selector})`));
  const match = rule.match(new RegExp(`${property}:\\s*([^;]+);`));
  if (!match?.[1]) {
    throw new Error(`no ${property} on ${selector} in typeset.css`);
  }
  return match[1].trim();
}

describe("the quote's scale is shadcn/typeset's", () => {
  test("a heading steps the way the stylesheet steps it", () => {
    expect(declared("h1", "font-size")).toBe(`${QUOTE_TYPESET.heading[1]}em`);
    expect(declared("h2", "font-size")).toBe(`${QUOTE_TYPESET.heading[2]}em`);
    expect(declared("h3", "font-size")).toBe(`${QUOTE_TYPESET.heading[3]}em`);
    expect(declared("h4", "font-size")).toBe(
      `${QUOTE_TYPESET.smallestHeading}em`,
    );
  });

  test("a heading is set at the weight the stylesheet sets", () => {
    expect(declared("h1, h2, h3, h4, h5, h6", "font-weight")).toBe(
      `${QUOTE_TYPESET.weight.heading}`,
    );
  });

  test("the body leading is the stylesheet's default", () => {
    // Upstream declares it on `.typeset`, not inside the element block.
    const match = upstream.match(/--typeset-leading:\s*([^;]+);/);
    expect(match?.[1]?.trim()).toBe(`${QUOTE_TYPESET.leading.body}`);
  });

  test("a heading's leading is one number between the three upstream sets", () => {
    // react-pdf takes one; upstream steps 1.3, 1.4 and 1.45 by level.
    const levels = [1, 2, 3].map((n) =>
      Number(declared(`h${n}`, "line-height")),
    );
    expect(QUOTE_TYPESET.leading.heading).toBeGreaterThanOrEqual(
      Math.min(...levels),
    );
    expect(QUOTE_TYPESET.leading.heading).toBeLessThanOrEqual(
      Math.max(...levels),
    );
  });

  test("a block is spaced the way the stylesheet spaces it", () => {
    const flow = upstream.match(/--typeset-flow:\s*([^;]+);/)?.[1]?.trim();
    expect(flow).toBe(`${QUOTE_TYPESET.flow.paragraph}em`);
    // A heading takes the flow above it and owns an em below.
    expect(declared("h1", "margin-block-start")).toBe("var(--typeset-flow)");
    expect(QUOTE_TYPESET.flow.above).toBe(QUOTE_TYPESET.flow.paragraph);
    expect(
      declared(
        "h1 + *, h2 + *, h3 + *, h4 + *, h5 + *, h6 + *",
        "margin-block-start",
      ),
    ).toBe(`${QUOTE_TYPESET.flow.below}em`);
  });
});
