/**
 * Realtime delivers a row only to a subscriber allowed to SELECT it, so a
 * table in the supabase_realtime publication whose read policy carries no
 * expression is silent — the same symptom as never having been published.
 *
 * This reads schema.ts rather than a database, so it runs in CI and catches
 * the regression at the point someone makes it.
 */
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../schema";

/** Kept in step with the table list in supabase/20-realtime.sql. */
const PUBLISHED = [
  "activities",
  "customers",
  "documents",
  "inbox",
  "insights",
  "transactions",
];

function policiesFor(tableName: string) {
  for (const value of Object.values(schema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      continue;
    }
    if (config.name === tableName) return config.policies;
  }
  throw new Error(`no table named ${tableName} in schema.ts`);
}

describe("tables published to realtime", () => {
  for (const table of PUBLISHED) {
    test(`${table} lets a subscriber read the rows it subscribes to`, () => {
      const readable = policiesFor(table).filter(
        (policy) =>
          (policy.for === "select" || policy.for === "all") && policy.using,
      );

      expect(readable.map((policy) => policy.name)).not.toEqual([]);
    });
  }
});
