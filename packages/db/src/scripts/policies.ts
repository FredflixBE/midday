/**
 * The RLS policies declared in schema.ts, as SQL.
 *
 * `drizzle-kit push` creates every policy without its USING or WITH CHECK
 * expression: on the push path it unpacks policies with
 * `PgSquasher.unsquashPolicyPush`, which parses only name/as/for/to and drops
 * the rest (drizzle-kit 0.31.10). A policy with no USING grants nothing, so
 * after a push every table is closed to the anon and authenticated roles —
 * invisible to the API, which connects as the owner, but fatal to anything
 * holding the publishable key, realtime included.
 *
 * So the bootstrap re-creates them from schema.ts, which is the freshest
 * source there is: no generated file to fall out of step, and no dependency on
 * the migration snapshot being current.
 */
import type { PgPolicyToOption } from "drizzle-orm/pg-core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import * as schema from "../schema";

const dialect = new PgDialect();

/**
 * How many policies in schema.ts carry a name and a command but no expression,
 * and so grant nothing. FF-1429 restored or authored the last of them, so this
 * is now zero and stays zero: a policy without an expression is a table closed
 * to the browser, and the API bypasses RLS, so nothing else would notice.
 */
export const KNOWN_POLICIES_WITHOUT_EXPRESSION = 0;

/** Postgres keywords that must not be quoted in a policy's TO list. */
const BARE_ROLES = new Set([
  "public",
  "current_user",
  "current_role",
  "session_user",
]);

function quoteIdent(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function qualify(schemaName: string | undefined, table: string) {
  const t = quoteIdent(table);
  return schemaName ? `${quoteIdent(schemaName)}.${t}` : `public.${t}`;
}

/** `to` is a role, a role name, or a nest of either. Flatten it to names. */
function roleNames(to: PgPolicyToOption): string[] {
  if (Array.isArray(to)) return to.flatMap(roleNames);
  return [typeof to === "string" ? to : to.name];
}

export type PolicyStatement = {
  name: string;
  /** Schema-qualified and quoted, ready to interpolate. */
  table: string;
  /** Run before `create`: this is what repairs the one push left behind. */
  drop: string;
  create: string;
  /** The command, uppercased: SELECT, INSERT, UPDATE, DELETE or ALL. */
  command: string;
  /** The rendered expression, or "" when the policy declares none. */
  using: string;
  /** The rendered expression, or "" when the policy declares none. */
  withCheck: string;
  /** False when schema.ts declares no USING and no WITH CHECK, so it grants nothing. */
  restricts: boolean;
};

export type PolicyStatements = {
  /** One `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` per table with policies. */
  enableRls: string[];
  policies: PolicyStatement[];
};

/**
 * Every policy in schema.ts, as statements safe to run against a database that
 * push has already touched.
 */
export function policyStatements(): PolicyStatements {
  const enableRls: string[] = [];
  const policies: PolicyStatement[] = [];

  for (const value of Object.values(schema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      continue; // Not a table: an enum, a relation, a helper.
    }

    if (config.policies.length === 0) continue;

    const table = qualify(config.schema, config.name);
    enableRls.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);

    for (const policy of config.policies) {
      const to = roleNames(policy.to ?? "public")
        .map((name) => (BARE_ROLES.has(name) ? name : quoteIdent(name)))
        .join(", ");

      const usingExpression = policy.using
        ? dialect.sqlToQuery(policy.using).sql
        : "";
      const withCheckExpression = policy.withCheck
        ? dialect.sqlToQuery(policy.withCheck).sql
        : "";

      const using = usingExpression ? ` USING (${usingExpression})` : "";
      const withCheck = withCheckExpression
        ? ` WITH CHECK (${withCheckExpression})`
        : "";

      const name = quoteIdent(policy.name);
      const command = (policy.for ?? "all").toUpperCase();

      policies.push({
        name: policy.name,
        table,
        command,
        using: usingExpression,
        withCheck: withCheckExpression,
        restricts: using !== "" || withCheck !== "",
        drop: `DROP POLICY IF EXISTS ${name} ON ${table};`,
        create: `CREATE POLICY ${name} ON ${table} AS ${(policy.as ?? "permissive").toUpperCase()} FOR ${command} TO ${to}${using}${withCheck};`,
      });
    }
  }

  return { enableRls, policies };
}
