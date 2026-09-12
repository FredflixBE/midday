/**
 * Confirm the match suggestions that are not in any doubt, in bulk.
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs confirm-matches                 # says what it would do
 *   bun run --cwd packages/jobs confirm-matches --confirm       # does it
 *   bun run --cwd packages/jobs confirm-matches --min 0.98 --confirm
 *
 * **Dry by default.** Nothing is written unless `--confirm` is passed, and what
 * it would write is printed first.
 *
 * ## Why this exists
 *
 * Pulling the accountant's invoices (FF-1450) put a few hundred documents in
 * front of their transactions at once, and the matcher answered with
 * suggestions rather than attachments: auto-matching needs three previously
 * confirmed matches for the same supplier pair, and a fresh inbox has none. So
 * the first run of it leaves a hundred one-click confirmations, which is a
 * chore a person should not have to do to get started — and after which
 * auto-matching can carry the rest.
 *
 * It goes through `confirmSuggestedMatch`, the same function the button in the
 * inbox calls, so a confirmation made here is indistinguishable from one made
 * by hand: the attachment, the activity and the learning are all the same. Each
 * one can be undone in the UI exactly as if it had been clicked.
 *
 * **It prints supplier names**, which the read-only verification scripts
 * deliberately do not — judging what is about to be attached is the whole point
 * of running it. Do not paste its output into this repository, which is public.
 */
import { closeDb, connectDb } from "@midday/db/client";
import { confirmSuggestedMatch, getTeamIdsWithApp } from "@midday/db/queries";
import { inbox, transactionMatchSuggestions } from "@midday/db/schema";
import { YUKI_APP_ID } from "@midday/yuki/team";
import { and, desc, eq, gte } from "drizzle-orm";

/**
 * The floor a suggestion has to clear.
 *
 * 0.95 rather than the matcher's own auto-match threshold of 0.90, because this
 * confirms without anybody looking and the matcher's threshold assumes somebody
 * did. On the first real backlog, 89 of 118 suggestions sat at or above it, and
 * every one was a recurring supplier billing the same amount every month.
 */
const DEFAULT_MINIMUM_CONFIDENCE = 0.95;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const write = process.argv.includes("--confirm");
  const minimum = Number(argument("min") ?? String(DEFAULT_MINIMUM_CONFIDENCE));

  if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 1) {
    throw new Error(`--min must be between 0 and 1, got "${argument("min")}"`);
  }

  const db = await connectDb();

  // Every team that has the accounting app, which is who this is for. A team
  // without it has no bulk of suggestions to clear.
  const teamIds = await getTeamIdsWithApp(db, YUKI_APP_ID);

  for (const teamId of teamIds) {
    const pending = await db
      .select({
        id: transactionMatchSuggestions.id,
        inboxId: transactionMatchSuggestions.inboxId,
        transactionId: transactionMatchSuggestions.transactionId,
        confidence: transactionMatchSuggestions.confidenceScore,
        supplier: inbox.displayName,
      })
      .from(transactionMatchSuggestions)
      .innerJoin(inbox, eq(inbox.id, transactionMatchSuggestions.inboxId))
      .where(
        and(
          eq(transactionMatchSuggestions.teamId, teamId),
          eq(transactionMatchSuggestions.status, "pending"),
          gte(transactionMatchSuggestions.confidenceScore, String(minimum)),
        ),
      )
      .orderBy(desc(transactionMatchSuggestions.confidenceScore));

    console.log(
      `\n━━━ team ${teamId.slice(0, 8)}… — ${pending.length} suggestions at or above ${minimum}\n`,
    );

    if (pending.length === 0) continue;

    const bySupplier = new Map<string, number>();
    for (const row of pending) {
      const name = row.supplier ?? "(no name)";
      bySupplier.set(name, (bySupplier.get(name) ?? 0) + 1);
    }

    for (const [supplier, count] of [...bySupplier.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${String(count).padStart(3)}  ${supplier}`);
    }

    if (!write) {
      console.log(
        `\n  Dry run — nothing written. Pass --confirm to attach these ${pending.length}.`,
      );
      continue;
    }

    let confirmed = 0;
    let failed = 0;

    for (const suggestion of pending) {
      try {
        await confirmSuggestedMatch(db, {
          teamId,
          suggestionId: suggestion.id,
          inboxId: suggestion.inboxId,
          transactionId: suggestion.transactionId,
          // No user: nobody clicked this one. The suggestion records who acted,
          // and claiming a person did would make the learning read as human
          // judgement it never had.
          userId: null,
        });
        confirmed += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `  failed: ${suggestion.supplier ?? suggestion.inboxId} — ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }

    console.log(
      `\n  Attached ${confirmed} of ${pending.length}${failed > 0 ? `, ${failed} failed` : ""}.`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
