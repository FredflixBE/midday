/**
 * Read what the invoices already pulled from Yuki actually billed (FF-1572).
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs read-billed-amounts            # counts what it would read
 *   bun run --cwd packages/jobs read-billed-amounts --confirm  # triggers the reads
 *
 * **Dry by default.** The dry pass counts the pulled rows that still carry only
 * Yuki's booked amount, and writes nothing.
 *
 * ## Why this exists
 *
 * A pulled row's amount is the accountant's booked figure, in euro. For a
 * foreign invoice that is a conversion nobody paid — Cursor's $19.95 booked as
 * €17.22 — and the suggestion card showed it beside the €17.57 the card actually
 * took. From FF-1572 on, the pull reads each new invoice's own total before it
 * matches. This does the same, once, for the rows pulled before that.
 *
 * It is not a repair script: it triggers the ordinary `yuki-read-billed-amount`
 * task, which changes a row only when the invoice is in another currency and its
 * total agrees with the booked one. A euro invoice, an unreadable one, and a row
 * somebody corrected by hand are all left alone.
 *
 * **It costs one extraction per row** — OCR plus a model call — and the task
 * skips a row it has already corrected, so running this twice costs the second
 * time nothing. It does not re-run the matcher: see the task for why.
 *
 * Prints no supplier names, amounts or invoice numbers: this repository is
 * public.
 */

import { closeDb, connectDb } from "@midday/db/client";
import {
  getTeamIdsWithApp,
  getYukiInboxIdsForBilledAmount,
} from "@midday/db/queries";
import { YUKI_APP_ID } from "@midday/yuki/team";
import { tasks } from "@trigger.dev/sdk";

/** Triggers per batch call. The task's own queue runs five at a time. */
const CHUNK = 100;

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb();

  const teamIds = await getTeamIdsWithApp(db, YUKI_APP_ID);
  if (teamIds.length === 0) {
    console.log("No team has connected Yuki.");
    return;
  }

  for (const teamId of teamIds) {
    const inboxIds = await getYukiInboxIdsForBilledAmount(db, { teamId });

    console.log(`\nteam ${teamId.slice(0, 8)}…`);
    console.log(
      `  ${inboxIds.length} pulled rows still carry only the booked amount`,
    );

    if (!write) {
      console.log("  Nothing triggered — pass --confirm.");
      continue;
    }

    for (let i = 0; i < inboxIds.length; i += CHUNK) {
      const chunk = inboxIds.slice(i, i + CHUNK);

      await tasks.batchTrigger(
        "yuki-read-billed-amount",
        chunk.map((inboxId) => ({ payload: { teamId, inboxId } })),
      );

      console.log(`  triggered ${chunk.length}`);
    }

    console.log(
      "\n  Triggered. Each run says what it decided; check them in Trigger.dev.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
