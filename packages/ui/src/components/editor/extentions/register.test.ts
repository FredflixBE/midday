import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { registerExtensions } from "./register";
import { editorSchema } from "./schema";

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
    {
      type: "diagram",
      attrs: { source: "flowchart LR\n A --> B", path: "team/quotes/d.png" },
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

  // A diagram's source is what makes it editable again and its path is what
  // every renderer draws, so losing either loses the diagram (FF-1643).
  test("keeps a diagram's source and picture where none may be written", () => {
    const drawn = roundTrip({}).content[2];
    expect(drawn.type).toBe("diagram");
    expect(drawn.attrs.source).toBe("flowchart LR\n A --> B");
    expect(drawn.attrs.path).toBe("team/quotes/d.png");
  });
});

/** A schema as what it can hold: each node's content, group and attrs, each mark's attrs. */
function holds(schema: ReturnType<typeof getSchema>) {
  const attrs = (type: {
    spec: { attrs?: Record<string, { default?: unknown }> };
  }) =>
    Object.fromEntries(
      Object.entries(type.spec.attrs ?? {}).map(([name, spec]) => [
        name,
        spec.default,
      ]),
    );
  return {
    nodes: Object.fromEntries(
      Object.values(schema.nodes).map((node) => [
        node.name,
        {
          content: node.spec.content ?? "",
          group: node.spec.group ?? "",
          marks: node.spec.marks ?? null,
          attrs: attrs(node),
        },
      ]),
    ),
    marks: Object.fromEntries(
      Object.values(schema.marks).map((mark) => [mark.name, attrs(mark)]),
    ),
  };
}

describe("the schema a server builds (FF-1791)", () => {
  // What the MCP writes into a quote's text is built on this schema, so it
  // must hold exactly what every editor holds, or a server would write what
  // the editor then strips, or refuse what it keeps.
  test("holds exactly what every editor holds", () => {
    for (const options of [
      {},
      { images: { srcOf: () => null }, diagrams: true },
    ]) {
      expect(holds(editorSchema)).toEqual(
        holds(getSchema(registerExtensions(options))),
      );
    }
  });
});
