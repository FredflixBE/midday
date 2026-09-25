/**
 * Remove the second copies of invoices already in the inbox (FF-1549).
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs dedupe-invoice-copies            # says what it would remove
 *   bun run --cwd packages/jobs dedupe-invoice-copies --confirm  # removes them
 *
 * **Dry by default.** The dry pass reads, lists every set of copies with the
 * document it keeps and the ones it would remove, and writes nothing.
 *
 * ## Why this exists
 *
 * Email ingestion used to refuse a second copy only when its bytes matched.
 * Google and Adobe send every invoice to both of a team's connected mailboxes
 * as separately generated PDFs, so each arrived twice and each copy grew its
 * own match suggestion. Ingestion now refuses them on what they say
 * (`resolveInvoiceCopies`); this removes the ones that arrived before that.
 *
 * ## What it removes, and what it will not touch
 *
 * Exactly what ingestion would have refused: for each set of live documents
 * with the same supplier, invoice number, amount, currency and type, the
 * redundant email copies. That includes a copy confirmed onto the same payment
 * as the survivor — the commonest case in production, where both mailboxes'
 * PDFs ended up attached to one payment. Never a copy linked to a different
 * payment, never a copy from the books. A removed copy is deleted the way the
 * inbox deletes one: its attachment comes off the payment (the survivor's
 * stays) and its suggestions go with it. See `planInvoiceCopies` for which copy
 * survives.
 *
 * Prints inbox ids and counts, no supplier names, amounts or invoice numbers:
 * this repository is public, and output gets pasted into tickets.
 */

import { closeDb, connectDb } from "@midday/db/client";
import { resolveInvoiceCopies } from "@midday/db/queries";
import { inbox } from "@midday/db/schema";
import { and, isNotNull, ne, sql } from "drizzle-orm";

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb({ readOnly: !write });

  // Every live document that shares its team, invoice number and amount with
  // another. A superset of the copies: resolveInvoiceCopies decides the rest.
  const members = await db
    .select({ id: inbox.id, teamId: inbox.teamId })
    .from(inbox)
    .where(
      and(
        ne(inbox.status, "deleted"),
        isNotNull(inbox.invoiceNumber),
        sql`(${inbox.teamId}, upper(regexp_replace(${inbox.invoiceNumber}, '\\s+', '', 'g')), ${inbox.amount}) IN (
          SELECT team_id, upper(regexp_replace(invoice_number, '\\s+', '', 'g')), amount
          FROM inbox
          WHERE status IS DISTINCT FROM 'deleted' AND invoice_number IS NOT NULL
          GROUP BY 1, 2, 3
          HAVING count(*) > 1
        )`,
      ),
    );

  console.log(
    `${members.length} documents share an invoice number and amount with another.`,
  );

  // Asking from each member finds every set, and each set once per member;
  // the kept document names the set.
  const sets = new Map<string, { teamId: string; removed: Set<string> }>();
  const removed = new Set<string>();

  for (const member of members) {
    if (removed.has(member.id)) {
      continue;
    }
    const result = await resolveInvoiceCopies(db, {
      inboxId: member.id,
      teamId: member.teamId,
      apply: write,
    });
    if (!result) {
      continue;
    }
    const set = sets.get(result.keep) ?? {
      teamId: member.teamId,
      removed: new Set<string>(),
    };
    for (const id of result.removed) {
      set.removed.add(id);
      removed.add(id);
    }
    sets.set(result.keep, set);
  }

  for (const [keep, set] of sets) {
    console.log(`keep ${keep}  remove ${[...set.removed].join(", ")}`);
  }

  console.log(
    `${sets.size} invoices have copies; ${removed.size} copies ${write ? "removed" : "would be removed"}.`,
  );

  if (!write) {
    console.log("Dry run. Nothing was written. Pass --confirm to write.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
