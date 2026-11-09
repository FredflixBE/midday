import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  forClaude,
  MAX_OPTIONAL_FIELDS,
  MAX_UNION_FIELDS,
  optionalFieldCount,
  unionFieldCount,
} from "./structured";

const lineItem = z.object({
  description: z.string().nullable().describe("What was bought"),
  quantity: z.number().nullable(),
});

/** Shaped like the invoice schema: more nullable fields than Claude allows. */
const invoice = z.object({
  document_type: z.enum(["invoice", "receipt", "other"]),
  ...Object.fromEntries(
    Array.from({ length: 18 }, (_, i) => [
      `field_${i}`,
      z.string().nullable().describe(`Field ${i}`),
    ]),
  ),
  tax_type: z.enum(["vat", "gst"]).nullable(),
  line_items: z.array(lineItem).describe("Each line"),
});

describe("forClaude", () => {
  test("the schema as written breaks Claude's limit of 16 union-typed fields", () => {
    expect(unionFieldCount(invoice)).toBeGreaterThan(16);
  });

  test("what is sent stays inside both of Claude's limits", () => {
    const { schema } = forClaude(invoice);

    expect(unionFieldCount(schema)).toBeLessThanOrEqual(MAX_UNION_FIELDS);
    expect(optionalFieldCount(schema)).toBeLessThanOrEqual(MAX_OPTIONAL_FIELDS);
  });

  test("relaxes the fields declared last, so the important first ones stay required", () => {
    const sent = z.toJSONSchema(forClaude(invoice).schema) as {
      required: string[];
    };

    expect(sent.required).toContain("field_0");
    expect(sent.required).toContain("line_items");
    // 21 unions, so five are relaxed: the two inside a line item, then
    // tax_type, field_17 and field_16.
    expect(sent.required).not.toContain("tax_type");
    expect(sent.required).not.toContain("field_17");
    expect(sent.required).toContain("field_15");
  });

  test("asks for Claude's native structured output, never the tool fallback", () => {
    expect(forClaude(invoice).providerOptions).toEqual({
      anthropic: { structuredOutputMode: "outputFormat" },
    });
  });

  test("refuses a schema no relaxing can fit", () => {
    const huge = z.object(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`f${i}`, z.string().nullable()]),
      ),
    );

    expect(() => forClaude(huge)).toThrow("structured output");
  });

  test("keeps each field's description", () => {
    const sent = z.toJSONSchema(forClaude(invoice).schema) as {
      properties: Record<string, { description?: string; items?: any }>;
    };

    expect(sent.properties.field_3?.description).toBe("Field 3");
    expect(sent.properties.field_17?.description).toBe("Field 17");
    expect(sent.properties.line_items?.description).toBe("Each line");
    expect(
      sent.properties.line_items?.items?.properties?.description?.description,
    ).toBe("What was bought");
  });

  test("a field the model left out comes back as null, as the schema says", () => {
    const { restore } = forClaude(invoice);

    const result: Record<string, unknown> = restore({
      document_type: "invoice",
      field_0: "INV-1",
      line_items: [{ description: "Coffee" }],
    });

    expect(result.field_0).toBe("INV-1");
    expect(result.field_1).toBeNull();
    expect(result.tax_type).toBeNull();
    expect(result.line_items).toEqual([
      { description: "Coffee", quantity: null },
    ]);
  });

  test("a value the original schema refuses still fails", () => {
    const { restore } = forClaude(invoice);

    expect(() =>
      restore({ document_type: "letter", line_items: [] }),
    ).toThrow();
  });

  test("leaves a schema with no nullable field as it is", () => {
    const plain = z.object({ title: z.string(), tags: z.array(z.string()) });

    expect(forClaude(plain).restore({ title: "x", tags: [] })).toEqual({
      title: "x",
      tags: [],
    });
  });
});
