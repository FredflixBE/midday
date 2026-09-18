/**
 * Detect the commitments in every team's history (FF-1591).
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs detect-commitments            # says what it would do
 *   bun run --cwd packages/jobs detect-commitments --confirm  # does it
 *
 * **Dry by default.** The dry pass counts what would be proposed, by kind,
 * cadence and price kind, and writes nothing.
 *
 * ## Why this exists
 *
 * Detection runs inside enrichment for the suppliers a run touched, which
 * attaches next month's payment to its commitment. The series already in
 * history would otherwise wait for each supplier's next payment to be read.
 * This is the same detection, over every supplier, once, by hand. Safe to run
 * again: a payment already in a commitment, or one a person took out of every
 * commitment, is not touched, and a commitment is never edited once proposed.
 *
 * Every commitment it writes is `proposed`: a person confirms, corrects or
 * rejects it. Needs migration 0017_commitments, and suppliers linked over
 * history (`link-suppliers --confirm`) — detection reads series per supplier.
 *
 * Prints no supplier names or amounts: this repository is public.
 */

import { closeDb, connectDb } from "@midday/db/client";
import { detectCommitments, planCommitments } from "@midday/db/queries";

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb();

  const teams = await db.query.teams.findMany({ columns: { id: true } });

  for (const { id: teamId } of teams) {
    const plan = await planCommitments(db, { teamId });

    console.log(`\n━━━ team ${teamId.slice(0, 8)}…`);
    console.log(`  ${plan.attach.length} payments continue a commitment`);
    console.log(`  ${plan.propose.length} new series to propose`);

    const shapes = new Map<string, number>();
    for (const { kind, series } of plan.propose) {
      const shape = `${kind}, ${series.cadence}, ${series.priceKind}`;
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    }
    for (const [shape, count] of [...shapes].sort()) {
      console.log(`    ${count} × ${shape}`);
    }

    if (!write) {
      console.log("\n  Nothing written — pass --confirm.");
      continue;
    }

    const result = await detectCommitments(db, { teamId });
    console.log(
      `\n  ${result.attached} attached, ${result.proposed} proposed — confirm or reject them on each supplier's page`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
