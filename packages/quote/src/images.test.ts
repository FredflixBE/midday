import { describe, expect, test } from "bun:test";
import type { QuoteContent } from "./content";
import { imagePathsIn } from "./images";

const contentWith = (blocks: unknown[]) =>
  ({
    blocks,
    rates: { productRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios: [],
  }) as unknown as QuoteContent;

const image = (path: string) => ({ type: "image", attrs: { path } });
const diagram = (path: string | null) => ({
  type: "diagram",
  attrs: { source: "flowchart LR\n A --> B", path },
});
const text = (id: string, content: unknown[]) => ({
  id,
  type: "text",
  heading: null,
  body: { type: "doc", content },
});

describe("imagePathsIn", () => {
  // A diagram is drawn to a picture when it is written (FF-1643), and that
  // picture is stored and let go of on exactly the same terms as any other.
  // Everything downstream reads this one list: the bytes the PDF draws from,
  // the paths a save keeps, and the paths FF-1626 deletes. A diagram missing
  // from it is a diagram dropped from every sent quote, and a file nothing
  // ever cleans up.
  test("names a diagram's picture too", () => {
    const content = contentWith([
      text("a", [image("team/quotes/one.png"), diagram("team/quotes/d.png")]),
    ]);

    expect(imagePathsIn(content)).toEqual([
      "team/quotes/one.png",
      "team/quotes/d.png",
    ]);
  });

  test("passes over a diagram written but not yet drawn", () => {
    expect(imagePathsIn(contentWith([text("a", [diagram(null)])]))).toEqual([]);
  });

  test("names every picture, in the order it is written", () => {
    const content = contentWith([
      text("a", [{ type: "paragraph" }, image("team/quotes/one.png")]),
      { id: "p", type: "pricing" },
      text("b", [image("team/quotes/two.png")]),
    ]);

    expect(imagePathsIn(content)).toEqual([
      "team/quotes/one.png",
      "team/quotes/two.png",
    ]);
  });

  test("finds one nested in a list, and names a repeat once", () => {
    const content = contentWith([
      text("a", [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [image("team/quotes/one.png")] },
          ],
        },
        image("team/quotes/one.png"),
      ]),
    ]);

    expect(imagePathsIn(content)).toEqual(["team/quotes/one.png"]);
  });

  test("is empty on text that holds none", () => {
    expect(
      imagePathsIn(contentWith([text("a", [{ type: "paragraph" }])])),
    ).toEqual([]);
    expect(imagePathsIn(contentWith([{ id: "p", type: "pricing" }]))).toEqual(
      [],
    );
  });

  test("passes over an image node with no path", () => {
    const content = contentWith([
      text("a", [{ type: "image", attrs: {} }, { type: "image" }]),
    ]);
    expect(imagePathsIn(content)).toEqual([]);
  });
});
