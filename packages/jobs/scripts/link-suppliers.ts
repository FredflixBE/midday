/**
 * Recognise the supplier of every payment that has none yet (FF-1555).
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs link-suppliers            # says what it would do
 *   bun run --cwd packages/jobs link-suppliers --confirm  # does it
 *
 * **Dry by default.** The dry pass counts the payments with no supplier and
 * the counterparties the model would be asked about, and writes nothing.
 *
 * ## Why this exists
 *
 * Recognition runs inside enrichment, and enrichment only ever sees new
 * payments. Everything Midday held before suppliers existed would otherwise
 * stay unlinked for good. This is the same recognition, on the ordinary path —
 * stored rules first, the model only for what they leave, its answers kept as
 * rules — run over history once, by hand. Safe to run again: a payment that
 * already has a supplier, or that a person decided has none, is not touched.
 *
 * Its cost is one model question per new counterparty, not per payment.

 *
 * Prints no supplier names or amounts: this repository is public.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { askSuppliersWith } from "@jobs/utils/supplier-question";
import { closeDb, connectDb } from "@midday/db/client";
import {
  groupForSupplierQuestions,
  recogniseSuppliers,
} from "@midday/db/queries";
import { transactions } from "@midday/db/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";

/** Payments per recognition pass. Keeps one model prompt a readable size. */
const CHUNK = 50;

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb();

  const unlinked = and(
    isNull(transactions.supplierLink),
    lt(transactions.amount, 0),
    or(isNull(transactions.internal), eq(transactions.internal, false)),
  );

  const teams = await db
    .selectDistinct({ teamId: transactions.teamId })
    .from(transactions)
    .where(unlinked);

  if (teams.length === 0) {
    console.log("Every payment already has a supplier, or a person's answer.");
  }

  const google = createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  const ask = askSuppliersWith(google("gemini-3.5-flash-lite"));

  for (const { teamId } of teams) {
    const rows = await db
      .select({
        id: transactions.id,
        name: transactions.name,
        counterpartyName: transactions.counterpartyName,
        counterpartyIban: transactions.counterpartyIban,
        merchantName: transactions.merchantName,
        description: transactions.description,
        amount: transactions.amount,
        internal: transactions.internal,
      })
      .from(transactions)
      .where(and(eq(transactions.teamId, teamId), unlinked));

    console.log(
      `\n━━━ team ${teamId.slice(0, 8)}… — ${rows.length} payments with no supplier`,
    );
    console.log(
      `  at most ${groupForSupplierQuestions(rows, new Set()).length} counterparties to ask about (fewer once rules exist)`,
    );

    if (!write) {
      console.log("\n  Nothing written — pass --confirm.");
      continue;
    }

    let linked = 0;
    let asked = 0;
    let created = 0;
    let guessed = 0;
    let notAskedAgain = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const result = await recogniseSuppliers(db, {
        teamId,
        transactions: rows.slice(i, i + CHUNK),
        ask,
      });

      linked += result.suppliers.size;
      asked += result.asked;
      created += result.created;
      guessed += result.guessed;
      notAskedAgain += result.notAskedAgain;

      console.log(
        `  ${Math.min(i + CHUNK, rows.length)} of ${rows.length} read`,
      );
    }

    console.log(`\n  ${linked} payments now have a supplier`);
    console.log(`  ${asked} counterparties were asked about`);
    console.log(`  ${created} suppliers were created`);
    console.log(
      `  ${guessed} linked on the model's word alone, shown as a guess`,
    );
    console.log(
      `  ${notAskedAgain} not asked about: the model it could not name that party`,
    );
    console.log(`  ${rows.length - linked} still have none, and say so`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
