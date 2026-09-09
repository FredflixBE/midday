/**
 * The policy SQL the bootstrap applies after `drizzle-kit push`, which creates
 * policies without their expressions. These assertions are about the SQL text
 * because that text is the deliverable; supabase-sql.test.ts covers what the
 * policies then allow, against a real database.
 */
import { describe, expect, test } from "bun:test";
import {
  KNOWN_POLICIES_WITHOUT_EXPRESSION,
  policyStatements,
} from "../scripts/policies";

describe("policyStatements", () => {
  const { enableRls, policies } = policyStatements();

  test("carries the team check that push drops", () => {
    // Without the WITH CHECK this policy grants nothing at all, which is
    // exactly the state push leaves behind.
    const policy = policies.find(
      (p) => p.name === "Transactions can be created by a member of the team",
    );

    expect(policy?.create).toBe(
      'CREATE POLICY "Transactions can be created by a member of the team" ON public."transactions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));',
    );
  });

  test("drops each policy before creating it, so a pushed one is repaired", () => {
    for (const policy of policies) {
      expect(policy.drop).toBe(
        `DROP POLICY IF EXISTS "${policy.name}" ON ${policy.table};`,
      );
    }
  });

  test("no policy is added without an expression", () => {
    // A policy with neither USING nor WITH CHECK grants nothing at all. There
    // were 44 of them; FF-1429 restored or authored the last one, so the only
    // number that passes now is zero. The API bypasses RLS, so nothing else
    // in the suite would notice a new one.
    const toothless = policies.filter((p) => !p.restricts);

    expect(toothless.map((p) => `${p.table} ${p.name}`)).toEqual([]);
    expect(toothless.length).toBeLessThanOrEqual(
      KNOWN_POLICIES_WITHOUT_EXPRESSION,
    );
  });

  test("no policy grants nothing in practice either", () => {
    // An UPDATE policy with a WITH CHECK but no USING makes no existing row
    // selectable for update, so it updates zero rows — verified directly, it
    // is not treated as true. `restricts` above cannot see this shape, because
    // such a policy does carry an expression.
    //
    // transaction_enrichments had the last one. FF-1442 deleted it rather than
    // completing it: the only completion consistent with the dump was
    // USING (true), and nothing needs the table from a browser anyway.
    const dead = policies
      .filter((p) => p.command === "UPDATE" && !p.using && p.withCheck)
      .map((p) => `${p.table} ${p.name}`);

    expect(dead).toEqual([]);
  });

  test("enables row level security on every table it writes a policy for", () => {
    for (const table of new Set(policies.map((p) => p.table))) {
      expect(enableRls).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
    }
  });

  test("enables it on a table that has no policies on purpose", () => {
    // The dangerous case, and the reason this is asserted rather than assumed.
    // Supabase grants anon/authenticated/service_role ALL on tables in `public`
    // through default privileges, so RLS is the only thing standing between a
    // signed-in browser and a table. A table whose policies are all deleted
    // must therefore still be listed here — if it is skipped for having none,
    // deleting the last policy silently opens the table to everyone.
    expect(enableRls).toContain(
      'ALTER TABLE public."transaction_enrichments" ENABLE ROW LEVEL SECURITY;',
    );
    expect(
      policies.filter((p) => p.table.includes("transaction_enrichments")),
    ).toEqual([]);
  });
});
