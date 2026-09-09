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

  test("no new policy is added without an expression", () => {
    // These carry a name and a command but no expression, so they grant
    // nothing. They are FF-1429's to restore or author; this is a ratchet, not
    // an endorsement — it fails if the count grows, and passes as FF-1429
    // brings it down.
    const toothless = policies.filter((p) => !p.restricts);

    expect(toothless.length).toBeLessThanOrEqual(
      KNOWN_POLICIES_WITHOUT_EXPRESSION,
    );
  });

  test("enables row level security on every table it writes a policy for", () => {
    for (const table of new Set(policies.map((p) => p.table))) {
      expect(enableRls).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
    }
  });
});
