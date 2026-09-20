import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { registerExtensions } from "./register";

// What a quote's text holds once a table has been written in it.
const withTable = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Before" }] },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Feature" }],
                },
              ],
            },
            {
              type: "tableCell",
              attrs: { colspan: 2 },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Basis" }],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "After" }] },
  ],
};

type Shape = { type: string; text?: string; content?: Shape[] };

/** A node's type and words, without the attrs a schema fills in for itself. */
function shapeOf(node: {
  type: string;
  text?: string;
  content?: Shape[];
}): Shape {
  return {
    type: node.type,
    ...(node.text ? { text: node.text } : {}),
    ...(node.content ? { content: node.content.map(shapeOf) } : {}),
  };
}

/** The text as it would be saved again after being opened here. */
function roundTrip(options: Parameters<typeof registerExtensions>[0]) {
  const schema = getSchema(registerExtensions(options));
  return schema.nodeFromJSON(withTable).toJSON();
}

describe("the shared schema", () => {
  // The whole reason the four table nodes are registered everywhere rather
  // than only where one can be written (FF-1642): Tiptap throws away nodes
  // its schema does not know, so an editor built without them would strip a
  // table out of text it was only meant to show, and the next keystroke
  // would save the text without it.
  test("keeps a table in text opened where no table may be written", () => {
    expect(shapeOf(roundTrip({}))).toEqual(shapeOf(withTable));
  });

  test("keeps it just the same in an editor built to hold pictures", () => {
    const out = roundTrip({ images: { srcOf: () => null } });
    expect(shapeOf(out)).toEqual(shapeOf(withTable));
  });

  test("keeps a column span, which every renderer draws", () => {
    const row = roundTrip({}).content[1].content[0];
    expect(row.content[1].attrs.colspan).toBe(2);
  });
});
