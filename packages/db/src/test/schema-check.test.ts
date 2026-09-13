/**
 * The check that decides whether `test:e2e:setup` worked.
 *
 * Two things are asserted here. That the checker can tell an unbuilt database
 * from a built one — on a scratch database it makes and drops itself — and
 * that the database this suite is running against is in fact built. The second
 * is the tripwire FF-1559 asked for: when the setup silently skips the schema,
 * this says so in one line, rather than leaving 36 tests to fail on a column
 * that is plainly in schema.ts.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test \
 *     bun test src/test/schema-check.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { pointAt, sslFor } from "../scripts/apply-sql";
import {
  type MissingObject,
  missingSchemaObjects,
} from "../scripts/schema-check";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_DATABASE_URL;

const SCRATCH = "midday_schema_check_scratch";

/** flatMap rather than filter+map: a filter predicate does not narrow a union. */
function missingTables(missing: MissingObject[]): string[] {
  return missing.flatMap((object) =>
    object.kind === "table" ? [object.name] : [],
  );
}

function missingColumns(missing: MissingObject[], table: string): string[] {
  return missing.flatMap((object) =>
    object.kind === "column" && object.table === table ? [object.name] : [],
  );
}

describe.skipIf(SKIP)(
  "what schema.ts declares and a database has not got",
  () => {
    // `describe.skipIf` still runs this body to collect the tests, so nothing
    // here may touch the URL: the whole-graph CI job has no Postgres service
    // and TEST_DATABASE_URL is unset there. Parsing it eagerly threw
    // `"undefined" cannot be parsed as a URL` between tests, in a job that
    // never intended to run this file at all.
    const url = TEST_DATABASE_URL as string;

    let scratch: Client;

    async function admin(sql: string) {
      const client = new Client({
        connectionString: pointAt(url, "postgres"),
        ssl: sslFor(url),
      });
      await client.connect();
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    }

    beforeAll(async () => {
      await admin(`drop database if exists ${SCRATCH} with (force)`);
      await admin(`create database ${SCRATCH}`);

      const scratchUrl = pointAt(url, SCRATCH);
      scratch = new Client({
        connectionString: scratchUrl,
        ssl: sslFor(scratchUrl),
      });
      await scratch.connect();
    });

    afterAll(async () => {
      await scratch?.end();
      await admin(`drop database if exists ${SCRATCH} with (force)`);
    });

    test("an empty database is missing every table", async () => {
      const missing = await missingSchemaObjects(scratch);

      const tables = missingTables(missing);

      // Whatever schema.ts holds today, none of it is here.
      expect(tables.length).toBeGreaterThan(40);
      expect(tables).toContain("public.transactions");

      // And nothing is reported as a missing column, because reporting both for
      // a table that is wholly absent is noise.
      expect(missingColumns(missing, "public.transactions")).toEqual([]);
    });

    test("a table that is there but short of a column reports the column", async () => {
      await scratch.query("create table public.transactions (id uuid)");

      const missing = await missingSchemaObjects(scratch);

      expect(missingTables(missing)).not.toContain("public.transactions");

      const columns = missingColumns(missing, "public.transactions");

      // `id` is the one column it has, so it is the one that is not reported.
      expect(columns.length).toBeGreaterThan(0);
      expect(columns).not.toContain("id");
      expect(columns).toContain("amount");
    });

    test("the database this suite runs against has the whole schema", async () => {
      const client = new Client({ connectionString: url, ssl: sslFor(url) });
      await client.connect();

      try {
        const missing = await missingSchemaObjects(client);

        // If this fails, test:e2e:setup did not apply schema.ts. Re-run it and
        // read what it says — it now refuses to finish quietly. FF-1559.
        expect(missing).toEqual([]);
      } finally {
        await client.end();
      }
    });
  },
);
