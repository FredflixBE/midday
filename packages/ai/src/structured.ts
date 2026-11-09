/**
 * Fitting a zod schema into Claude's native structured output.
 *
 * Claude refuses a response schema with more than 16 union-typed fields —
 * "Schemas contains too many parameters with union types … (limit: 16
 * parameters with unions)", a 400 on every call — and `@ai-sdk/anthropic`
 * only sends a schema natively when it has at most 10 optional fields; past
 * that it falls back to a JSON tool the model is merely invited to call.
 * A nullable field counts as a union, and the invoice schema has 21.
 *
 * `forClaude` makes just enough nullable fields optional instead, starting
 * from the last one declared (schemas here list the fields that matter
 * first), to fit both limits. `restore` puts `null` back for every field the
 * model left out and checks the answer against the original schema, so
 * everything downstream keeps reading `null` as "not on the document".
 */

import { z } from "zod";

/** Claude's limit on union-typed (including nullable) fields per schema. */
export const MAX_UNION_FIELDS = 16;

/** `@ai-sdk/anthropic`'s limit on optional fields for native structured output. */
export const MAX_OPTIONAL_FIELDS = 10;

type Shape = Record<string, z.ZodType>;
type Path = string;

function described<T extends z.ZodType>(schema: T, description?: string): T {
  return description ? (schema.describe(description) as T) : schema;
}

/** Every nullable field's path, depth first, in declaration order. */
function nullablePaths(field: z.ZodType, path: Path = ""): Path[] {
  if (field instanceof z.ZodNullable) {
    return [path, ...nullablePaths(field.unwrap() as z.ZodType, path)];
  }
  if (field instanceof z.ZodOptional) {
    return nullablePaths(field.unwrap() as z.ZodType, path);
  }
  if (field instanceof z.ZodObject) {
    return Object.entries(field.shape as Shape).flatMap(([key, child]) =>
      nullablePaths(child, `${path}/${key}`),
    );
  }
  if (field instanceof z.ZodArray) {
    return nullablePaths(field.element as z.ZodType, `${path}/*`);
  }
  return [];
}

/** The schema with the nullable fields at `relaxed` made optional instead. */
function relax(
  field: z.ZodType,
  relaxed: Set<Path>,
  path: Path = "",
): z.ZodType {
  if (field instanceof z.ZodNullable) {
    const inner = field.unwrap() as z.ZodType;
    const description = field.description ?? inner.description;
    const child = relax(inner, relaxed, path);
    return described(
      relaxed.has(path) ? child.optional() : child.nullable(),
      description,
    );
  }

  if (field instanceof z.ZodOptional) {
    return described(
      relax(field.unwrap() as z.ZodType, relaxed, path).optional(),
      field.description,
    );
  }

  if (field instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(field.shape as Shape).map(([key, child]) => [
        key,
        relax(child, relaxed, `${path}/${key}`),
      ]),
    );
    return described(z.object(shape), field.description);
  }

  if (field instanceof z.ZodArray) {
    return described(
      z.array(relax(field.element as z.ZodType, relaxed, `${path}/*`)),
      field.description,
    );
  }

  return field;
}

/** The answer with `null` wherever the original schema allows one and the model left the field out. */
function fillNulls(field: z.ZodType, value: unknown): unknown {
  if (field instanceof z.ZodNullable) {
    return value === undefined || value === null
      ? null
      : fillNulls(field.unwrap() as z.ZodType, value);
  }

  if (field instanceof z.ZodOptional) {
    return value === undefined
      ? undefined
      : fillNulls(field.unwrap() as z.ZodType, value);
  }

  if (field instanceof z.ZodObject && value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(field.shape as Shape).map(([key, child]) => [
        key,
        fillNulls(child, input[key]),
      ]),
    );
  }

  if (field instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item) => fillNulls(field.element as z.ZodType, item));
  }

  return value;
}

export function forClaude<T extends z.ZodType>(
  original: T,
): {
  schema: z.ZodType;
  restore: (value: unknown) => z.infer<T>;
  providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } };
} {
  const candidates = nullablePaths(original).reverse();
  const relaxed = new Set<Path>();
  let schema = relax(original, relaxed);

  while (unionFieldCount(schema) > MAX_UNION_FIELDS && candidates.length > 0) {
    relaxed.add(candidates.shift()!);
    schema = relax(original, relaxed);
  }

  if (
    unionFieldCount(schema) > MAX_UNION_FIELDS ||
    optionalFieldCount(schema) > MAX_OPTIONAL_FIELDS
  ) {
    throw new Error(
      `This schema cannot fit Claude's structured output: ${unionFieldCount(schema)} union-typed fields (limit ${MAX_UNION_FIELDS}) and ${optionalFieldCount(schema)} optional ones (limit ${MAX_OPTIONAL_FIELDS}). Split it, or make fields required.`,
    );
  }

  return {
    schema,
    restore: (value) => original.parse(fillNulls(original, value)),
    // Never the JSON-tool fallback: the Claude 5.5 models refuse to be forced
    // to call it, so it is only a suggestion the model may ignore. A schema
    // outside the limits throws above instead of degrading to that.
    providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } },
  };
}

type JsonNode = Record<string, unknown>;

function walk(
  node: unknown,
  visit: (property: JsonNode, required: boolean) => number,
): number {
  if (!node || typeof node !== "object") return 0;
  const object = node as JsonNode;
  const required = new Set((object.required as string[]) ?? []);
  let total = 0;

  for (const [name, property] of Object.entries(
    (object.properties as Record<string, JsonNode>) ?? {},
  )) {
    total += visit(property, required.has(name)) + walk(property, visit);
  }
  if (object.items) total += walk(object.items, visit);
  for (const option of (object.anyOf as unknown[]) ?? []) {
    total += walk(option, visit);
  }

  return total;
}

/** Fields, at any depth, that are union-typed in JSON Schema — the count Claude limits to 16. */
export function unionFieldCount(schema: z.ZodType): number {
  return walk(z.toJSONSchema(schema), (property) =>
    Array.isArray(property.type) || Array.isArray(property.anyOf) ? 1 : 0,
  );
}

/** Fields, at any depth, that are not required — the count the provider limits to 10. */
export function optionalFieldCount(schema: z.ZodType): number {
  return walk(z.toJSONSchema(schema), (_property, required) =>
    required ? 0 : 1,
  );
}
