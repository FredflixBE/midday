/**
 * Which database a script is pointed at, and whether it may write to it.
 *
 * `bun run` loads `packages/db/.env`, and on this machine that file's
 * connection points at the hosted Supabase project holding the real books.
 * Nothing in a connection string says so: two projects differ by one opaque
 * ref, in files that look identical. A script run in the wrong shell reaches
 * production and says nothing about it, which has already happened once.
 *
 * This is the same treatment `packages/jobs/scripts/register-bank-scheduler-team.ts`
 * gives Trigger, for the database:
 *
 * - Every script prints what it is about to act on, before it acts.
 * - A script is assumed to **write**, and refuses against production unless
 *   `CONFIRM_DATABASE_PROD=true`. A script that only reads says so where it
 *   opens the connection, with `{ readOnly: true }` — so a script added later
 *   is guarded without its author having to remember anything.
 * - The refusal names what it saw, so a misconfiguration is one line rather
 *   than a mystery.
 *
 * None of this touches the API, the jobs or the tests: the guard is inert
 * unless the process was started from a file under a `scripts/` directory.
 *
 * ## Why an environment variable and not a row in the database
 *
 * `DATABASE_ENVIRONMENT` is set beside the connection string it describes, so
 * the label and the thing it labels travel together — and what is actually
 * ambiguous here is the shell, not the data. A row would survive being copied
 * into another project, which an env var does not; that is the one thing it
 * would do better, and it costs a migration and a bootstrap step to get. The
 * env var needs neither, and an unset one is refused rather than assumed safe,
 * which closes the hole that would otherwise make the cheaper option the
 * weaker one.
 */

import { resolve } from "node:path";

export type DatabaseEnvironment =
  | "production"
  | "development"
  | "test"
  | "unknown";

const ENVIRONMENT_NAMES: Record<string, DatabaseEnvironment> = {
  production: "production",
  prod: "production",
  development: "development",
  dev: "development",
  local: "development",
  test: "test",
  ci: "test",
};

/** The variable a deployment sets to say which environment it is. */
export const ENVIRONMENT_VARIABLE = "DATABASE_ENVIRONMENT";

/** The variable that confirms a deliberate write to production. */
export const CONFIRM_VARIABLE = "CONFIRM_DATABASE_PROD";

/**
 * Whether a connection string names a database on this machine.
 *
 * The host is compared exactly, and read with a URL parser rather than matched
 * in the string. Matching on `@localhost` is what this used to do, and it is
 * wrong in both directions: userinfo ends at the *last* `@`, so
 * `postgres://u:pw@localhost:@prod.example.com/proddb` contains `@localhost:`
 * while pointing at prod.example.com — and a credential-free
 * `postgres://localhost:5433/midday_test` contains no `@` at all and was
 * refused. Scripts that drop databases decide on this answer, so it is one
 * function and not a regex in three files.
 */
export function isLocalDatabase(connectionString: string): boolean {
  try {
    return isLocalHostname(new URL(connectionString).hostname);
  } catch {
    // Not parseable is not local. Whatever it is, nothing here should act on
    // it.
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * What the deployment says this database is. Unset, or set to something this
 * does not recognise, is `unknown` — which is refused, not waved through.
 */
export function declaredEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseEnvironment {
  const declared = env[ENVIRONMENT_VARIABLE]?.trim().toLowerCase();
  if (!declared) return "unknown";
  return ENVIRONMENT_NAMES[declared] ?? "unknown";
}

export type ScriptTarget = {
  environment: DatabaseEnvironment;
  /** Supabase project ref, when the connection string carries one. */
  project: string | null;
  host: string | null;
  database: string | null;
  local: boolean;
};

/**
 * The Supabase project a connection string names, read from wherever that
 * deployment puts it: the session pooler carries it in the user
 * (`postgres.<ref>`), a direct connection in the host (`db.<ref>.supabase.co`).
 *
 * Display only. Nothing decides anything on this value — the day a ref changes
 * shape, a wrong label is a cosmetic bug, where a wrong decision is the defect
 * this whole module exists to prevent.
 */
function projectRef(url: URL): string | null {
  const fromUser = url.username.match(/^postgres\.([a-z0-9]+)$/i);
  if (fromUser?.[1]) return fromUser[1];

  const fromHost = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.(co|com)$/i);
  return fromHost?.[1] ?? null;
}

/** Everything the banner and the refusal need to say, and nothing secret. */
export function describeTarget(
  connectionString: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ScriptTarget {
  const environment = declaredEnvironment(env);

  if (!connectionString) {
    return {
      environment,
      project: null,
      host: null,
      database: null,
      local: false,
    };
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Not parseable is not local. Whatever it is, nothing here should act on
    // it unconfirmed.
    return {
      environment,
      project: null,
      host: null,
      database: null,
      local: false,
    };
  }

  return {
    environment,
    project: projectRef(url),
    host: url.hostname || null,
    database: url.pathname.replace(/^\//, "") || null,
    local: isLocalHostname(url.hostname),
  };
}

/**
 * Whether writing to this target needs saying so out loud.
 *
 * The declared environment decides, with one relaxation: a database on this
 * machine is never production. That exemption only ever loosens toward
 * localhost, so it cannot mistake a hosted project for a safe one — a Supabase
 * host is not `localhost` — while it keeps the guard from firing on the test
 * database, which is the harmless work a guard must not interrupt if it is to
 * survive.
 */
export function needsConfirmation(target: ScriptTarget): boolean {
  if (target.local) return false;
  return (
    target.environment === "production" || target.environment === "unknown"
  );
}

/**
 * Targets already named out loud, so a script that opens two connections does
 * not repeat itself — and does still announce the second one when it differs.
 * A single flag would have named one database while the process acted on
 * another.
 */
const announced = new Set<string>();

/** Test seam. Forgets what a process would otherwise only say once. */
export function resetScriptGuard(): void {
  announced.clear();
}

/**
 * Whether this process was started from a script.
 *
 * The entry file is the honest signal: `packages/db/src/scripts/*` and
 * `packages/jobs/scripts/*` are exactly the files a person runs by hand, and
 * the API, the jobs and the tests enter through none of them. It also means a
 * new file dropped into either directory is guarded the moment it exists.
 */
export function isScriptEntry(argv: string[] = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;

  // Resolved, because `bun link-suppliers.ts` from inside the directory passes
  // a bare filename, and a guard that switches itself off depending on which
  // directory you were standing in is worse than no guard.
  return /(^|\/)scripts\/[^/]+$/.test(resolve(entry));
}

function describeEnvironment(target: ScriptTarget): string {
  if (target.local) return `${target.environment} (a database on this machine)`;
  if (target.environment === "unknown") {
    return `unknown (${ENVIRONMENT_VARIABLE} is not set)`;
  }
  return `${target.environment} (${ENVIRONMENT_VARIABLE})`;
}

function targetLines(target: ScriptTarget): string {
  return [
    `  environment: ${describeEnvironment(target)}`,
    `  project:     ${target.project ?? "(not a Supabase connection string)"}`,
    `  host:        ${target.host ?? "(no connection string set)"}`,
    `  database:    ${target.database ?? "(none)"}`,
  ].join("\n");
}

/** The one-line banner, so a script says where it is before it does anything. */
export function announcement(target: ScriptTarget, readOnly: boolean): string {
  const where = [
    target.project && `project ${target.project}`,
    target.host && `host ${target.host}`,
    target.database && `database ${target.database}`,
  ]
    .filter(Boolean)
    .join(", ");

  const mode = readOnly ? "read-only" : "may write";
  return `db: ${target.environment}${where ? ` — ${where}` : ""} (${mode})`;
}

/** The refusal, which has to name what it saw or it is just an obstacle. */
export function refusal(target: ScriptTarget): string {
  const headline =
    target.environment === "production"
      ? "Refusing to run a script that may write against production."
      : `Refusing to run a script against a database that does not say which environment it is.`;

  const remedy =
    target.environment === "production"
      ? `Re-run with ${CONFIRM_VARIABLE}=true if that is what you meant.`
      : `Set ${ENVIRONMENT_VARIABLE} beside this connection string — see SELF_HOSTING.md — or re-run with ${CONFIRM_VARIABLE}=true if it really is production.`;

  return [
    headline,
    targetLines(target),
    remedy,
    "If this connection only reads, open it with { readOnly: true }.",
  ].join("\n");
}

export type ScriptConnectionOptions = {
  /**
   * Set only by a connection that provably reads and never writes. It is a
   * property of the call, not of the process: a module-wide flag would be
   * disarmed for a whole run the day a writing script imports a helper out of
   * a read-only one, which is exactly the silent failure this file exists to
   * prevent.
   */
  readOnly?: boolean;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

/**
 * Say what this script is about to act on, and stop it if it may write to
 * production without having said so.
 *
 * Called by every way a script can reach the database — `connectDb`,
 * `createJobDb`, and by hand in the few scripts that open their own connection.
 * Inert outside a script entry point, so the API and the jobs never see it.
 */
export function guardScriptConnection(
  connectionString: string | undefined = process.env.DATABASE_URL,
  options: ScriptConnectionOptions = {},
): void {
  const { readOnly = false, argv = process.argv, env = process.env } = options;

  if (!isScriptEntry(argv)) return;

  const target = describeTarget(connectionString, env);
  const key = `${target.environment}:${target.host}:${target.database}:${readOnly}`;

  if (!announced.has(key)) {
    announced.add(key);
    console.error(announcement(target, readOnly));
  }

  if (readOnly) return;
  if (!needsConfirmation(target)) return;
  if (env[CONFIRM_VARIABLE] === "true") return;

  throw new Error(refusal(target));
}
