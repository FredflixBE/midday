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

  test("only one policy is left that grants nothing in practice", () => {
    // An UPDATE policy with WITH CHECK but no USING makes no existing row
    // selectable for update, so it updates zero rows — verified directly, it
    // is not treated as true. Production's transaction_enrichments policy is
    // exactly that, and restoring it verbatim was the instruction; widening it
    // to USING (true) would let any authenticated user rewrite any team's
    // enrichments. Tracked separately; nothing reads that table with the
    // publishable key today.
    const dead = policies
      .filter((p) => p.command === "UPDATE" && !p.using && p.withCheck)
      .map((p) => `${p.table} ${p.name}`);

    expect(dead).toEqual([
      'public."transaction_enrichments" Enable update for authenticated users only',
    ]);
  });

  test("enables row level security on every table it writes a policy for", () => {
    for (const table of new Set(policies.map((p) => p.table))) {
      expect(enableRls).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
    }
  });
});
