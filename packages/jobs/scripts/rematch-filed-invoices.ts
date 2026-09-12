/**
 * Offer the filed invoices a transaction again.
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs rematch-filed            # says what it would find
 *   bun run --cwd packages/jobs rematch-filed --confirm  # runs the matcher for real
 *
 * **Dry by default.** The dry pass calls `findMatches`, which reads and returns
 * the best candidate without writing anything; `--confirm` calls
 * `calculateInboxSuggestions`, the same function the pipeline uses, and then
 * closes each row again.
 *
 * ## Why this exists
 *
 * An invoice pulled from the books is closed on arrival whatever the matcher
 * found (FF-1450), so nothing ever looks at it again — which is right, because
 * a closed document must not reopen itself as work. But the first bulk run
 * matched 150 documents in two minutes, and `findMatches` skips any transaction
 * that already carries an attachment or a pending suggestion, so the documents
 * raced each other for the same payments (FF-1545). 42 of the 86 that found
 * nothing have a payment of the right size in Midday; for 28 of them the
 * transaction had already been offered to somebody else at the moment they
 * asked.
 *
 * Now that the contention has cleared — 132 of those suggestions are confirmed
 * and attached — asking again finds some of them. This is that second ask, run
 * once, by hand.
 *
 * **It is not a fix for FF-1545**, which is about not creating the race in the
 * first place. It is the mop.
 *
 * Every row it touches ends `done` again, exactly as it started: closed, with
 * or without a transaction. Where auto-matching is enabled and the supplier
 * pair has earned it, the match attaches itself; otherwise a suggestion is
 * raised for a person, and the row stays filed until they answer it.
 */
import { closeDb, connectDb } from "@midday/db/client";
import {
  calculateInboxSuggestions,
  findMatches,
  getTeamIdsWithApp,
  updateInbox,
} from "@midday/db/queries";
import { inbox } from "@midday/db/schema";
import { YUKI_APP_ID } from "@midday/yuki/team";
import { and, eq, isNull, like } from "drizzle-orm";

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb();

  for (const teamId of await getTeamIdsWithApp(db, YUKI_APP_ID)) {
    // Pulled from the books, closed, and still carrying no transaction. A row
    // a person has since archived or deleted is not here, and nor is one that
    // found its payment the first time.
    const filed = await db
      .select({ id: inbox.id, supplier: inbox.displayName, date: inbox.date })
      .from(inbox)
      .where(
        and(
          eq(inbox.teamId, teamId),
          like(inbox.referenceId, "yuki:%"),
          eq(inbox.status, "done"),
          isNull(inbox.transactionId),
        ),
      )
      .orderBy(inbox.date);

    console.log(
      `\n━━━ team ${teamId.slice(0, 8)}… — ${filed.length} filed invoices with no transaction\n`,
    );

    if (filed.length === 0) continue;

    if (!write) {
      let found = 0;

      for (const row of filed) {
        // Read-only: the best candidate, scored, without persisting anything.
        const match = await findMatches(db, { teamId, inboxId: row.id });
        if (!match) continue;

        found += 1;
        console.log(
          `  ${row.date ?? "          "}  ${String(match.confidenceScore).slice(0, 5)}  ${row.supplier ?? "(no name)"}`,
        );
      }

      console.log(
        `\n  ${found} of ${filed.length} would find a transaction now. Nothing written — pass --confirm.`,
      );
      continue;
    }

    const counts = { autoMatched: 0, suggested: 0, nothing: 0, failed: 0 };

    for (const row of filed) {
      try {
        const result = await calculateInboxSuggestions(db, {
          teamId,
          inboxId: row.id,
        });

        if (result.action === "auto_matched") counts.autoMatched += 1;
        else if (result.action === "suggestion_created") counts.suggested += 1;
        else counts.nothing += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(
          `  failed: ${row.supplier ?? row.id} — ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }

      // Closed again either way. The matcher moves a row to analyzing and then
      // to pending or suggested_match on its way past, and a document the
      // accountant has already booked must not be left sitting in the inbox
      // looking like work — which is the rule the pull itself runs under.
      await updateInbox(db, { id: row.id, teamId, status: "done" });
    }

    console.log(
      `\n  Attached ${counts.autoMatched}, suggested ${counts.suggested}, still nothing ${counts.nothing}${
        counts.failed > 0 ? `, failed ${counts.failed}` : ""
      }.`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
