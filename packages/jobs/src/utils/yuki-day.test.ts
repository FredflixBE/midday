import { describe, expect, test } from "bun:test";
import { runYukiDay, totalCardCharges, totalPulledInvoices } from "./yuki-day";

describe("a Yuki day", () => {
  test("runs every team, in order", async () => {
    const seen: string[] = [];

    const result = await runYukiDay(["team-a", "team-b"], async (teamId) => {
      seen.push(teamId);
      return { ok: true };
    });

    expect(seen).toEqual(["team-a", "team-b"]);
    expect(result).toMatchObject({ teams: 2, succeeded: 2, failed: 0 });
  });

  test("keeps going when one team's books cannot be read", async () => {
    // A revoked key belongs to that team. Stopping here would leave every
    // other team's card unsynced, and the schedule runs once a day.
    const result = await runYukiDay(
      ["team-a", "team-broken", "team-c"],
      async (teamId) => {
        if (teamId === "team-broken") throw new Error("Invalid access key");
        return { ok: true };
      },
    );

    expect(result).toMatchObject({ teams: 3, succeeded: 2, failed: 1 });
    expect(result.outcomes.map((o) => o.ok)).toEqual([true, false, true]);
  });

  test("counts a run that answered `not ok` as a failure, not a success", async () => {
    const result = await runYukiDay(["team-a"], async () => ({ ok: false }));

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
  });

  test("does nothing at all when no team has Yuki", async () => {
    expect(await runYukiDay([], async () => ({ ok: true }))).toEqual({
      teams: 0,
      succeeded: 0,
      failed: 0,
      outcomes: [],
    });
  });
});

describe("what the Admin button will say", () => {
  test("adds up the per-team counts", async () => {
    const result = await runYukiDay(["a", "b"], async (teamId) => ({
      ok: true,
      output:
        teamId === "a"
          ? { charges: 147, invoiceMissing: 68, needsAttention: 0 }
          : { charges: 3, invoiceMissing: 1, needsAttention: 2 },
    }));

    expect(totalCardCharges(result)).toEqual({
      charges: 150,
      invoiceMissing: 69,
      needsAttention: 2,
    });
  });

  test("ignores a team that was skipped, and one that failed", async () => {
    // A skipped run answers `{ skipped: … }` with no counts at all, and a
    // failed one answers nothing. Neither may read as zero charges found.
    const result = await runYukiDay(["a", "b"], async (teamId) => {
      if (teamId === "a")
        return { ok: true, output: { skipped: "not_connected" } };
      throw new Error("nope");
    });

    expect(totalCardCharges(result)).toEqual({
      charges: 0,
      invoiceMissing: 0,
      needsAttention: 0,
    });
  });
});

describe("totalling what the invoice pull did", () => {
  test("adds up the teams, and what the matcher made of them", async () => {
    const result = await runYukiDay(["a", "b"], async (teamId) => ({
      ok: true,
      output:
        teamId === "a"
          ? {
              pulled: 50,
              failed: 1,
              remaining: 240,
              autoMatched: 2,
              suggested: 8,
              unmatched: 40,
            }
          : {
              pulled: 3,
              failed: 0,
              remaining: 0,
              autoMatched: 0,
              suggested: 1,
              unmatched: 2,
            },
    }));

    expect(totalPulledInvoices(result)).toEqual({
      pulled: 53,
      failed: 1,
      remaining: 240,
      // A suggestion is a payment found; confirming it is the human's click.
      matched: 11,
    });
  });

  test("reads a skipped team and a failed one as nothing, not as zero", async () => {
    const result = await runYukiDay(["a", "b"], async (teamId) => {
      if (teamId === "a") return { ok: true, output: { skipped: true } };
      throw new Error("nope");
    });

    expect(totalPulledInvoices(result)).toEqual({
      pulled: 0,
      failed: 0,
      remaining: 0,
      matched: 0,
    });
  });
});
