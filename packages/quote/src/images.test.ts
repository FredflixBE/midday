import { describe, expect, test } from "bun:test";
import type { QuoteContent } from "./content";
import { imagePathsIn, replaceImagePaths } from "./images";

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

describe("replaceImagePaths", () => {
  // A picture is held in the browser until the draft that names it is saved
  // (FF-1634), so what the editor carries is a stand-in and this is what puts
  // the stored path in its place, on the way to the server.
  test("puts the stored path in a picture's and a diagram's place", () => {
    const content = contentWith([
      text("a", [image("pending:one"), diagram("pending:two")]),
    ]);

    const next = replaceImagePaths(content, {
      "pending:one": "team/quotes/images/one.png",
      "pending:two": "team/quotes/images/two.png",
    });

    expect(imagePathsIn(next)).toEqual([
      "team/quotes/images/one.png",
      "team/quotes/images/two.png",
    ]);
  });

  test("keeps a diagram's source while replacing its path", () => {
    const content = contentWith([text("a", [diagram("pending:one")])]);
    const next = replaceImagePaths(content, { "pending:one": "team/q/d.png" });
    const node = (
      next.blocks[0] as unknown as { body: { content: { attrs: unknown }[] } }
    ).body.content[0];

    expect(node?.attrs).toEqual({
      source: "flowchart LR\n A --> B",
      path: "team/q/d.png",
    });
  });

  test("reaches one nested in a list, and every repeat of it", () => {
    const content = contentWith([
      text("a", [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [image("pending:one")] }],
        },
        image("pending:one"),
      ]),
    ]);

    const next = replaceImagePaths(content, { "pending:one": "team/q/1.png" });
    expect(JSON.stringify(next)).not.toContain("pending:one");
    expect(imagePathsIn(next)).toEqual(["team/q/1.png"]);
  });

  test("leaves a path nothing was stored for exactly as it was", () => {
    const content = contentWith([
      text("a", [image("team/quotes/kept.png"), diagram(null)]),
    ]);

    expect(
      replaceImagePaths(content, { "pending:gone": "team/q/x.png" }),
    ).toEqual(content);
  });

  test("gives back what it was given when nothing was stored", () => {
    const content = contentWith([text("a", [image("pending:one")])]);
    expect(replaceImagePaths(content, {})).toBe(content);
  });
});
