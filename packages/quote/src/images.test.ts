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
const text = (id: string, content: unknown[]) => ({
  id,
  type: "text",
  heading: null,
  body: { type: "doc", content },
});

describe("imagePathsIn", () => {
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
