/**
 * Realtime delivers a row only to a subscriber allowed to SELECT it, so a
 * table in the supabase_realtime publication whose read policy carries no
 * expression is silent — the same symptom as never having been published.
 *
 * This reads schema.ts rather than a database, so it runs in CI and catches
 * the regression at the point someone makes it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../schema";
import { PUBLISHED_TABLES } from "../scripts/realtime-tables";

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
  for (const table of PUBLISHED_TABLES) {
    test(`${table} lets a subscriber read the rows it subscribes to`, () => {
      const readable = policiesFor(table).filter(
        (policy) =>
          (policy.for === "select" || policy.for === "all") && policy.using,
      );

      expect(readable.map((policy) => policy.name)).not.toEqual([]);
    });
  }
});

describe("supabase/20-realtime.sql", () => {
  test("publishes exactly the tables PUBLISHED_TABLES names", () => {
    // The SQL is the source of truth; PUBLISHED_TABLES mirrors it so the
    // bootstrap check and the tests do not each keep their own list. This is
    // what stops the mirror drifting.
    const sql = readFileSync(
      resolve(__dirname, "../../supabase/20-realtime.sql"),
      "utf8",
    );

    const list = sql.match(/foreach t in array array\[([^\]]+)\]/)?.[1];
    const inSql = [...(list ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect(inSql.sort()).toEqual([...PUBLISHED_TABLES].sort());
  });
});
