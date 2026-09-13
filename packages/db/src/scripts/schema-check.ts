/**
 * What `schema.ts` declares and a database does not have.
 *
 * `drizzle-kit push` exits 0 when the statements inside it failed — see the
 * note on `runPush` in bootstrap.ts, and FF-1559 for the case that made this
 * file necessary. So the exit code cannot decide whether the schema landed.
 * This can: it reads the tables, columns and enum values out of `schema.ts`,
 * asks the database for the same, and returns the difference.
 *
 * It reports what is *missing*, never what is extra. A database that has more
 * than `schema.ts` describes is what every branch with an unmerged migration
 * looks like from the other side, and failing on that would make the check
 * unusable while stacked work is in flight.
 */

import { toSnakeCase } from "drizzle-orm/casing";
import { getTableConfig, isPgEnum, PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import * as schema from "../schema";

/** One thing `schema.ts` asks for that the database has not got. */
export type MissingObject =
  | { kind: "table"; name: string }
  | { kind: "column"; name: string; table: string }
  | { kind: "enum"; name: string }
  | { kind: "enum value"; enum: string; value: string };

/** `public.transactions`. Qualified, because a table need not be in public. */
function qualify(table: PgTable): string {
  const { name, schema: namespace } = getTableConfig(table);
  return `${namespace ?? "public"}.${name}`;
}

/** Every table `schema.ts` exports, by qualified name. */
function declaredTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;

    tables.set(
      qualify(value),
      // A column declared without an explicit name — `billingEmail`,
      // `isActive` — is named by the `casing` setting rather than by the
      // property, and drizzle reports the property until that setting is
      // applied. Every config and client in this package says `snake_case`
      // (drizzle.config.ts, drizzle.config.test.ts, client.ts,
      // worker-client.ts, job-client.ts), and `toSnakeCase` is the function
      // drizzle applies it with — so this asks for `billing_email`, which is
      // the column that exists.
      getTableConfig(value).columns.map((column) =>
        column.keyAsName ? toSnakeCase(column.name) : column.name,
      ),
    );
  }

  return tables;
}

/** Every enum `schema.ts` exports, name to its values. */
function declaredEnums(): Map<string, string[]> {
  const enums = new Map<string, string[]>();

  for (const value of Object.values(schema)) {
    if (!isPgEnum(value)) continue;
    enums.set(value.enumName, [...value.enumValues]);
  }

  return enums;
}

async function tableColumns(client: Client): Promise<Map<string, Set<string>>> {
  // information_schema.columns hides a column the current role cannot see, so
  // the catalog is asked directly. `attnum > 0` skips the system columns and
  // `not attisdropped` skips the tombstones a dropped column leaves behind.
  const { rows } = await client.query<{
    table: string;
    column: string;
  }>(`select n.nspname || '.' || c.relname as table, a.attname as column
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p')
         and n.nspname not in ('pg_catalog', 'information_schema')
         and a.attnum > 0
         and not a.attisdropped`);

  const found = new Map<string, Set<string>>();

  for (const row of rows) {
    const columns = found.get(row.table) ?? new Set<string>();
    columns.add(row.column);
    found.set(row.table, columns);
  }

  return found;
}

async function enumValues(client: Client): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ name: string; value: string }>(
    `select t.typname as name, e.enumlabel as value
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'`,
  );

  const found = new Map<string, Set<string>>();

  for (const row of rows) {
    const values = found.get(row.name) ?? new Set<string>();
    values.add(row.value);
    found.set(row.name, values);
  }

  return found;
}

/**
 * Everything `schema.ts` declares that this database has not got. An empty
 * array means the schema is applied.
 */
export async function missingSchemaObjects(
  client: Client,
): Promise<MissingObject[]> {
  const missing: MissingObject[] = [];

  const found = await tableColumns(client);

  for (const [table, columns] of declaredTables()) {
    const present = found.get(table);

    if (!present) {
      // Naming its columns as well would bury the one fact that matters.
      missing.push({ kind: "table", name: table });
      continue;
    }

    for (const column of columns) {
      if (!present.has(column)) {
        missing.push({ kind: "column", name: column, table });
      }
    }
  }

  const foundEnums = await enumValues(client);

  for (const [name, values] of declaredEnums()) {
    const present = foundEnums.get(name);

    if (!present) {
      missing.push({ kind: "enum", name });
      continue;
    }

    for (const value of values) {
      if (!present.has(value)) {
        missing.push({ kind: "enum value", enum: name, value });
      }
    }
  }

  return missing;
}

/** One line per missing object, for a person reading a failed setup run. */
export function describeMissing(missing: MissingObject[]): string[] {
  // An if-chain rather than a switch: a switch over the union is exhaustive to
  // TypeScript but not to biome, which then warns that the callback may return
  // nothing. The last branch is "enum value" by elimination.
  return missing.map((object) => {
    if (object.kind === "table") return `table ${object.name} is missing`;
    if (object.kind === "column") {
      return `${object.table} has no column ${object.name}`;
    }
    if (object.kind === "enum") return `enum ${object.name} is missing`;
    return `enum ${object.enum} has no value ${object.value}`;
  });
}
