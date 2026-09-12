/**
 * What one firing of the Yuki schedule does, with nothing scheduled about it.
 *
 * The ordering rule and the what-if-one-team-fails decision live here so they
 * can be read and tested without a Trigger.dev run, the way the recurring
 * invoice day does it.
 */

/** Once a day, early. Charges arrive with a monthly statement; more is waste. */
export const YUKI_CRON = "0 6 * * *";

export interface YukiTeamOutcome {
  teamId: string;
  ok: boolean;
  /** Whatever the per-team run answered, for the summary a person reads. */
  output?: unknown;
}

export interface YukiDayResult {
  teams: number;
  succeeded: number;
  failed: number;
  outcomes: YukiTeamOutcome[];
}

/**
 * Runs one step per team and keeps going when a team fails.
 *
 * A team whose Yuki key was revoked must not stop the other teams' books being
 * read: the failure belongs to that team, and the run's own logs say which one
 * it was. Teams are handled one at a time rather than all at once, because
 * Yuki's allowance is per domain but its patience is not — and the whole point
 * of this being a single schedule is that it stays small.
 */
export async function runYukiDay(
  teamIds: readonly string[],
  runTeam: (teamId: string) => Promise<{ ok: boolean; output?: unknown }>,
): Promise<YukiDayResult> {
  const outcomes: YukiTeamOutcome[] = [];

  for (const teamId of teamIds) {
    try {
      const result = await runTeam(teamId);
      outcomes.push({ teamId, ok: result.ok, output: result.output });
    } catch {
      outcomes.push({ teamId, ok: false });
    }
  }

  return {
    teams: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
  };
}

/**
 * Adds up what the per-team runs reported, for the one sentence Settings →
 * Admin shows when the button finishes.
 */
export function totalCardCharges(result: YukiDayResult): {
  charges: number;
  invoiceMissing: number;
  needsAttention: number;
} {
  const totals = { charges: 0, invoiceMissing: 0, needsAttention: 0 };

  for (const outcome of result.outcomes) {
    const output = outcome.output;
    if (!output || typeof output !== "object") continue;

    const fields = output as Record<string, unknown>;
    totals.charges += number(fields.charges);
    totals.invoiceMissing += number(fields.invoiceMissing);
    totals.needsAttention += number(fields.needsAttention);
  }

  return totals;
}

/**
 * Adds up what the per-team pulls reported, for the sentence Settings → Admin
 * shows when the button finishes (FF-1541).
 *
 * `remaining` is the one to read: it says whether the backlog is gone or wants
 * another run, which is the only reason a person is watching.
 */
export function totalPulledInvoices(result: YukiDayResult): {
  pulled: number;
  failed: number;
  remaining: number;
  matched: number;
  /** Whether any team stopped because Yuki's allowance for the day is spent. */
  dailyLimit: boolean;
} {
  const totals = {
    pulled: 0,
    failed: 0,
    remaining: 0,
    matched: 0,
    dailyLimit: false,
  };

  for (const outcome of result.outcomes) {
    const output = outcome.output;
    if (!output || typeof output !== "object") continue;

    const fields = output as Record<string, unknown>;
    totals.pulled += number(fields.pulled);
    totals.failed += number(fields.failed);
    totals.remaining += number(fields.remaining);
    totals.matched += number(fields.autoMatched) + number(fields.suggested);
    if (fields.dailyLimit === true) totals.dailyLimit = true;
  }

  return totals;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
