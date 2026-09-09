/**
 * `bun run db:bootstrap` — build a fresh Supabase project's schema, once.
 *
 * Order matters and is not arbitrary:
 *
 *   1. 00-bootstrap.sql   inbox.fts is a stored column calling
 *                         generate_inbox_fts, so the function has to exist
 *                         before the table does.
 *   2. drizzle-kit push   tables, columns, indexes, enums.
 *   3. policies           push creates every policy without its USING
 *                         expression, so they are re-created from schema.ts.
 *   4. 10-storage.sql     the three buckets.
 *   5. 11-storage-policies.sql
 *                         who may reach into them. Supabase owns
 *                         storage.objects, so this one often cannot be applied
 *                         from here; it is reported, not fatal.
 *   6. 20-realtime.sql    publication membership and the activities policy.
 *   7. 30-auth-user.sql   the trigger that gives a new sign-in a users row.
 *   8. 40-functions.sql   the functions the application calls at runtime.
 *   9. 50-documents.sql / 51-document-triggers.sql
 *                         a vault upload makes a documents row. The trigger
 *                         is on storage.objects, so it is reported rather
 *                         than fatal, like the storage policies.
 *  10. stamp              record the journal as applied, because step 2 built
 *                         the state the migrations describe without running
 *                         them — otherwise db:migrate would replay them.
 *  11. verification       the part you paste into the ticket.
 *
 * The verification is the real gate, because `drizzle-kit push` exits 0 even
 * when statements inside it failed.
 *
 * This is for an empty project. `db:migrate` is what keeps an existing one up
 * to date.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { applyPolicies } from "./apply-policies";
import { applySqlFile, sslFor } from "./apply-sql";
import { readJournal, stampMigrations } from "./migrations";
import { KNOWN_POLICIES_WITHOUT_EXPRESSION } from "./policies";
import { PUBLISHED_TABLES } from "./realtime-tables";

const PACKAGE_ROOT = resolve(__dirname, "../..");
const SUPABASE_DIR = resolve(PACKAGE_ROOT, "supabase");

/** The newest migration this schema already contains, by definition. */
const LAST_MIGRATION = readJournal().at(-1);

type Check = {
  what: string;
  sql: string;
  /** Given the rows, either "" for a pass or why it failed. */
  verdict: (rows: Record<string, unknown>[]) => string;
};

const CHECKS: Check[] = [
  {
    what: "vector and pg_trgm extensions installed",
    sql: "select extname from pg_extension where extname in ('vector','pg_trgm') order by extname",
    verdict: (rows) =>
      rows.length === 2
        ? ""
        : `found ${rows.map((r) => r.extname).join(", ") || "neither"}`,
  },
  {
    what: "private.get_teams_for_authenticated_user() exists, security definer",
    sql: `select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname = 'get_teams_for_authenticated_user'`,
    verdict: (rows) =>
      rows.length === 0
        ? "missing"
        : rows[0]!.prosecdef === true
          ? ""
          : "exists but is not SECURITY DEFINER",
  },
  {
    what: "inbox full-text functions exist",
    sql: `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and proname in ('generate_inbox_fts','extract_product_names')`,
    verdict: (rows) => (rows.length >= 2 ? "" : `found ${rows.length} of 2`),
  },
  {
    what: "inbox.fts is a stored generated column",
    sql: `select is_generated from information_schema.columns
           where table_name = 'inbox' and column_name = 'fts'`,
    verdict: (rows) =>
      rows[0]?.is_generated === "ALWAYS"
        ? ""
        : "not generated — the push did not use the function",
  },
  {
    what: "id generators exist, so a second team and invite can be created",
    sql: `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and proname in ('generate_inbox','nanoid','nanoid_optimized')`,
    verdict: (rows) => (rows.length >= 3 ? "" : `found ${rows.length} of 3`),
  },
  {
    what: "teams.inbox_id defaults to a call, not a literal",
    sql: `select column_default from information_schema.columns
           where table_name = 'teams' and column_name = 'inbox_id'`,
    verdict: (rows) =>
      rows[0]?.column_default === "generate_inbox(10)"
        ? ""
        : `default is ${JSON.stringify(rows[0]?.column_default)} — every team would share it`,
  },
  {
    what: "no public table named auth.users",
    sql: "select tablename from pg_tables where schemaname = 'public' and tablename = 'auth.users'",
    verdict: (rows) =>
      rows.length === 0 ? "" : "push created a table shadowing Supabase's",
  },
  {
    what: "users.id references auth.users, on delete cascade",
    sql: `select confrelid::regclass::text as refs, confdeltype from pg_constraint where conname = 'users_id_fkey'`,
    verdict: (rows) =>
      rows[0]?.refs === "auth.users" && rows[0]?.confdeltype === "c"
        ? ""
        : `references ${rows[0]?.refs ?? "nothing"}`,
  },
  {
    what: "buckets vault, avatars and apps exist, only vault private",
    sql: "select id, public from storage.buckets where id in ('vault','avatars','apps') order by id",
    verdict: (rows) => {
      if (rows.length !== 3) return `found ${rows.length} of 3`;
      const vault = rows.find((r) => r.id === "vault");
      return vault?.public === false ? "" : "vault is public";
    },
  },
  {
    // Counting policies would pass on twelve for one bucket, so name them.
    what: "every bucket has a policy for all four commands",
    sql: `select
             case
               when coalesce(qual, with_check) like '%''vault''%' then 'vault'
               when coalesce(qual, with_check) like '%''avatars''%' then 'avatars'
               when coalesce(qual, with_check) like '%''apps''%' then 'apps'
             end as bucket,
             cmd
           from pg_policies
          where schemaname = 'storage' and tablename = 'objects'`,
    verdict: (rows) => {
      const missing = ["vault", "avatars", "apps"].flatMap((bucket) => {
        const commands = new Set(
          rows.filter((r) => r.bucket === bucket).map((r) => r.cmd),
        );
        return ["SELECT", "INSERT", "UPDATE", "DELETE"]
          .filter((cmd) => !commands.has(cmd))
          .map((cmd) => `${bucket} ${cmd}`);
      });
      return missing.length === 0 ? "" : `no policy for ${missing.join(", ")}`;
    },
  },
  {
    what: "realtime publishes the six tables the dashboard watches",
    sql: `select tablename from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename`,
    verdict: (rows) => {
      const have = rows.map((r) => String(r.tablename));
      const missing = PUBLISHED_TABLES.filter((t) => !have.includes(t));
      return missing.length === 0 ? "" : `missing ${missing.join(", ")}`;
    },
  },
  {
    what: "row level security is on for activities",
    sql: "select relrowsecurity from pg_class where relname = 'activities' and relnamespace = 'public'::regnamespace",
    verdict: (rows) => (rows[0]?.relrowsecurity === true ? "" : "RLS is off"),
  },
  {
    what: "policy expressions survived the push",
    // The one that catches drizzle-kit push having created empty policies:
    // step 3 should have replaced every one it could.
    sql: `select count(*)::int as n from pg_policies
           where schemaname = 'public' and qual is null and with_check is null`,
    verdict: (rows) =>
      Number(rows[0]?.n ?? 0) <= KNOWN_POLICIES_WITHOUT_EXPRESSION
        ? ""
        : `${rows[0]?.n} policies grant nothing — expected at most ${KNOWN_POLICIES_WITHOUT_EXPRESSION}, so the policy step did not take`,
  },
  {
    // Without this, Google sign-in succeeds and then every request 404s,
    // because nothing else creates the public.users row.
    what: "a new sign-in gets a users row (on_auth_user_created)",
    sql: `select tgenabled from pg_trigger
           where tgname = 'on_auth_user_created'
             and tgrelid = 'auth.users'::regclass and not tgisinternal`,
    verdict: (rows) =>
      rows.length === 0
        ? "trigger missing"
        : rows[0]?.tgenabled === "D"
          ? "trigger is disabled"
          : "",
  },
  {
    // The gap FF-1439 closed: the app calls these at runtime, and a missing
    // one is a 500 on whichever page reaches it first.
    what: "the functions the app calls exist",
    sql: `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and proname in ('global_search','global_semantic_search',
                             'match_similar_documents_by_title',
                             'get_team_bank_accounts_balances',
                             'get_bank_account_currencies','slugify','total_duration',
                             'get_project_total_amount','get_assigned_users_for_project')`,
    verdict: (rows) => {
      const want = [
        "get_assigned_users_for_project",
        "get_bank_account_currencies",
        "get_project_total_amount",
        "get_team_bank_accounts_balances",
        "global_search",
        "global_semantic_search",
        "match_similar_documents_by_title",
        "slugify",
        "total_duration",
      ];
      const have = rows.map((r) => String(r.proname));
      const missing = want.filter((f) => !have.includes(f));
      return missing.length === 0 ? "" : `missing ${missing.join(", ")}`;
    },
  },
  {
    // Without this a vault upload lands in storage and never appears in the
    // vault, which lists documents rows rather than storage objects.
    what: "a vault upload makes a documents row (insert_into_documents)",
    sql: `select tgname from pg_trigger
           where tgrelid = 'storage.objects'::regclass and not tgisinternal
             and tgname in ('insert_into_documents','delete_from_documents')`,
    verdict: (rows) =>
      rows.length === 2 ? "" : `found ${rows.length} of 2 triggers`,
  },
  {
    // documents.fts is generated from title || ' ' || body, and NULL
    // concatenates to NULL, so NOT NULL here means a document with no title
    // cannot be inserted — which is every document at the moment of upload.
    what: "documents.fts is nullable, so a titleless upload can be inserted",
    sql: `select is_nullable from information_schema.columns
           where table_name = 'documents' and column_name = 'fts'`,
    verdict: (rows) =>
      rows[0]?.is_nullable === "YES"
        ? ""
        : "fts is NOT NULL — the upload trigger cannot insert",
  },
  {
    // Without this db:migrate would replay the base migration over a schema
    // the push already built, and fail on the first CREATE TABLE.
    what: "db:migrate has nothing left to apply",
    sql: "select coalesce(max(created_at), -1)::text as latest from drizzle.__drizzle_migrations",
    verdict: (rows) => {
      const latest = Number(rows[0]?.latest ?? -1);
      const want = LAST_MIGRATION?.when ?? -1;

      return latest >= want
        ? ""
        : `journal ends at ${LAST_MIGRATION?.tag ?? "nothing"}, the database records ${latest === -1 ? "no migration" : latest}`;
    },
  },
  {
    what: "the API roles can reach the schema",
    sql: `select has_table_privilege('authenticated', 'public.transactions', 'SELECT') as ok`,
    verdict: (rows) =>
      rows[0]?.ok === true
        ? ""
        : "authenticated has no SELECT on public.transactions",
  },
];

async function applyFile(client: Client, file: string) {
  await applySqlFile(client, resolve(SUPABASE_DIR, file));
  console.log(`  applied ${file}`);
}

/**
 * Applies a file that the connection may not be allowed to apply. Returns
 * false on a privilege error, which is a fact to report rather than a crash;
 * anything else still throws.
 */
async function tryApplyFile(client: Client, file: string): Promise<boolean> {
  try {
    await applyFile(client, file);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "42501") throw error;

    console.log(`  skipped ${file} — ${(error as Error).message}`);
    return false;
  }
}

function runPush(): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("bunx", ["drizzle-kit", "push", "--force"], {
      cwd: PACKAGE_ROOT,
      stdio: ["inherit", "ignore", "inherit"],
      env: process.env,
    });
    child.on("error", fail);
    // The exit code is not trusted either way: push has been seen to exit 0
    // with failed statements. The checks at the end are what decide.
    child.on("close", () => done());
  });
}

/** Returns the process exit code. */
async function main(): Promise<number> {
  const url = process.env.DATABASE_SESSION_POOLER;

  if (!url) {
    console.error(
      "DATABASE_SESSION_POOLER is not set. It is the session pooler URL from",
    );
    console.error(
      "Supabase > Project Settings > Database. Nothing has been changed.",
    );
    return 2;
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  try {
    // Never print the URL: it carries the database password.
    const { rows: where } = await client.query<{ db: string; host: string }>(
      "select current_database() as db, coalesce(inet_server_addr()::text, 'local') as host",
    );
    console.log(`Bootstrapping ${where[0]?.db} at ${where[0]?.host}\n`);

    const { rows: existing } = await client.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'public'",
    );
    const alreadyHasSchema = Number(existing[0]?.n ?? 0) > 0;

    if (alreadyHasSchema && process.env.ALLOW_NON_EMPTY !== "true") {
      console.error(`public already has ${existing[0]?.n} tables.`);
      console.error(
        "db:bootstrap is for an empty project, and it pushes with --force, which",
      );
      console.error(
        "drops what does not match the schema. Use db:migrate on a live database.",
      );
      console.error("");
      console.error(
        "If a previous run stopped part-way, this is how to continue it — every",
      );
      console.error(
        "step is idempotent, so re-running is safe while the project has no data:",
      );
      console.error("  ALLOW_NON_EMPTY=true bun run db:bootstrap");
      console.error("");
      console.error("Nothing has been changed.");
      return 2;
    }

    console.log("1. functions, extensions and the private schema");
    await applyFile(client, "00-bootstrap.sql");

    // Push is for building the schema, and it only does that once. Run again
    // over a schema that is already there, it finds policies whose expressions
    // step 3 filled in — which its own reading of schema.ts does not have — and
    // stops to ask whether they were renamed. There is no terminal to ask, and
    // no useful answer either: the schema is already what it should be.
    if (alreadyHasSchema) {
      console.log(
        "2. tables, columns and indexes — already here, skipping push",
      );
    } else {
      console.log("2. tables, columns and indexes (drizzle-kit push)");
      await runPush();
    }

    console.log("3. row level security policies, from schema.ts");
    const applied = await applyPolicies(client);
    console.log(`  applied ${applied} policies`);

    console.log("4. storage buckets");
    await applyFile(client, "10-storage.sql");

    console.log("5. storage policies");
    const storagePolicies = await tryApplyFile(
      client,
      "11-storage-policies.sql",
    );

    console.log("6. realtime publication");
    await applyFile(client, "20-realtime.sql");

    console.log("7. a users row for every new sign-in");
    await applyFile(client, "30-auth-user.sql");

    console.log("8. the functions the app calls at runtime");
    await applyFile(client, "40-functions.sql");

    console.log("9. a documents row for every vault upload");
    await applyFile(client, "50-documents.sql");
    const documentTriggers = await tryApplyFile(
      client,
      "51-document-triggers.sql",
    );

    console.log("10. recording the migrations this schema already contains");
    const stamped = await stampMigrations(client);
    console.log(
      `  stamped ${stamped} migration${stamped === 1 ? "" : "s"} as applied`,
    );

    console.log("\nVerification\n");
    let failed = 0;
    for (const check of CHECKS) {
      const { rows } = await client.query(check.sql);
      const problem = check.verdict(rows as Record<string, unknown>[]);
      if (problem) failed++;
      console.log(
        `  ${problem ? "FAIL" : "ok  "}  ${check.what}${problem ? ` — ${problem}` : ""}`,
      );
    }

    if (!documentTriggers) {
      console.log("");
      console.log(
        "The document triggers could not be applied from here, for the same",
      );
      console.log(
        "reason as the storage policies: Supabase owns storage.objects. Paste",
      );
      console.log(
        "packages/db/supabase/51-document-triggers.sql into the Supabase SQL",
      );
      console.log(
        "editor and run this again. Until then a vault upload lands in storage",
      );
      console.log("and never appears in the vault.");
    }

    if (!storagePolicies) {
      console.log("");
      console.log(
        "The storage policies could not be applied from here: Supabase owns",
      );
      console.log(
        "storage.objects, and Postgres wants the table's owner to create a policy.",
      );
      console.log(
        "Paste packages/db/supabase/11-storage-policies.sql into the Supabase SQL",
      );
      console.log(
        "editor, or use Storage > Policies in the dashboard, then run this again.",
      );
    }

    console.log("");
    if (failed > 0) {
      console.error(`${failed} of ${CHECKS.length} checks failed.`);
      return 1;
    }

    console.log(
      `All ${CHECKS.length} checks passed. Paste this output into FF-1395.`,
    );
    return 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
