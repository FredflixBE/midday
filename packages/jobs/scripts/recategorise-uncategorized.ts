/**
 * Ask the categoriser again about the payments it gave up on.
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs recategorise            # says what it would ask about
 *   bun run --cwd packages/jobs recategorise --confirm  # triggers the enrichment task
 *
 * **Dry by default.** The dry pass counts the payments sitting in
 * `uncategorized`, shows how many of them the bank or this team's own history
 * can already answer for without a model, and writes nothing.
 *
 * ## Why this exists
 *
 * A run that could not name a category wrote `uncategorized` and marked the row
 * finished. Both halves of that then excluded it from every later run, so the
 * rows were stuck: €52,288 of bank payments on the live books, including every
 * VAT payment (FF-1554).
 *
 * FF-1554 fixes the three causes — the allowed category list had no tax category
 * in it at all, `uncategorized` counted as an answer, and the model was asked
 * per payment rather than per counterparty. None of that reaches a row that has
 * already been given up on unless something asks again. This is that ask, run
 * once, by hand.
 *
 * It is not a repair script: it triggers the ordinary enrichment task, on the
 * ordinary path, with the ordinary guards. A payment somebody has categorised by
 * hand is not here and is never overwritten.
 *
 * Prints no supplier names, amounts or invoice numbers: this repository is
 * public.
 */

import {
  counterpartyKey,
  resolveKnownCategories,
} from "@jobs/utils/enrichment-helpers";
import { closeDb, connectDb } from "@midday/db/client";
import {
  getTransactionsForEnrichment,
  UNCATEGORIZED,
} from "@midday/db/queries";
import { transactions } from "@midday/db/schema";
import { tasks } from "@trigger.dev/sdk";
import { and, eq, lte } from "drizzle-orm";

/**
 * How many transaction ids go into one `enrich-transactions` trigger. The task
 * batches internally at 50; this only keeps one payload from carrying thousands
 * of ids.
 */
const CHUNK = 500;

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb();

  // Every team that has a payment parked in `uncategorized`. Teams are handled
  // one at a time because the remembered categories are per team.
  const teams = await db
    .selectDistinct({ teamId: transactions.teamId })
    .from(transactions)
    .where(eq(transactions.categorySlug, UNCATEGORIZED));

  if (teams.length === 0) {
    console.log("Nothing is sitting in uncategorized.");
    return;
  }

  for (const { teamId } of teams) {
    const parked = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.teamId, teamId),
          eq(transactions.categorySlug, UNCATEGORIZED),
          // Money out only: the categoriser does not classify income, and
          // `prepareUpdateData` would decline these anyway.
          lte(transactions.amount, 0),
        ),
      );

    console.log(
      `\n━━━ team ${teamId.slice(0, 8)}… — ${parked.length} payments in uncategorized\n`,
    );

    if (parked.length === 0) continue;

    // What the run will answer without a model call: the bank's own ISO 20022
    // code, and the category this team has already given that counterparty.
    const eligible = await getTransactionsForEnrichment(db, {
      teamId,
      transactionIds: parked.map((row) => row.id),
    });
    const known = await resolveKnownCategories(db, { teamId, batch: eligible });
    const counterparties = new Set(
      eligible
        .map((row) => counterpartyKey(row))
        .filter((name): name is string => name !== null),
    );

    console.log(`  ${eligible.length} are eligible to be asked again`);
    console.log(`  ${counterparties.size} distinct counterparties among them`);
    console.log(`  ${known.size} already answerable without a model`);

    if (!write) {
      console.log("\n  Nothing written — pass --confirm.");
      continue;
    }

    for (let i = 0; i < eligible.length; i += CHUNK) {
      const chunk = eligible.slice(i, i + CHUNK);

      await tasks.trigger("enrich-transactions", {
        teamId,
        transactionIds: chunk.map((row) => row.id),
      });

      console.log(`  triggered enrichment for ${chunk.length}`);
    }

    console.log(
      "\n  Triggered. The task writes as it goes; check the run in Trigger.dev.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
