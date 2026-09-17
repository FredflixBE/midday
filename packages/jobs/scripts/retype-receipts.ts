/**
 * Call the receipts in the inbox receipts, on the documents already there.
 *
 *   set -a; . apps/api/.env; set +a
 *   bun run --cwd packages/jobs retype-receipts            # says what it would change
 *   bun run --cwd packages/jobs retype-receipts --confirm  # writes
 *
 * **Dry by default.** The dry pass counts the documents whose file name says
 * receipt while the inbox calls them invoices, shows how many groups would get
 * a different primary as a result, and writes nothing.
 *
 * ## Why this exists
 *
 * `inbox.type` used to be decided by the mimetype: every PDF came out
 * `invoice`, every photo came out `expense`. A supplier who mails an invoice
 * and its own receipt as two PDFs therefore put two `invoice` rows in the inbox
 * carrying one invoice number, and `groupRelatedInboxItems` — which prefers an
 * invoice and falls through to the oldest — picked between them by arrival
 * time. FF-1533 fixes that for documents arriving from now on, by reading the
 * type the extraction had already produced.
 *
 * It cannot fix the documents already here: re-running the extraction over them
 * costs a model call each. The file name is the signal that survives without
 * one, and it is the same signal a person uses — `Invoice-…pdf` next to
 * `Receipt-…pdf` is not a close reading.
 *
 * ## What it changes, and what it will not touch
 *
 * One direction only: a row the inbox calls an invoice, whose file name says
 * receipt and does not say invoice. The reverse — a row called an expense whose
 * name says invoice — is left alone, because there the stored type may well
 * have come from an extraction that read the document, and a file name is not
 * evidence enough to overrule it.
 *
 * Then, for every group a retyped row belongs to, the primary is elected again
 * by the same rule `groupRelatedInboxItems` uses (prefer an invoice, then the
 * oldest). That is the visible half: the inbox lists primaries and nests the
 * rest, so a pair whose primary was the receipt showed the receipt.
 *
 * Prints no supplier names, amounts, file names or invoice numbers: this
 * repository is public.
 */

import { closeDb, connectDb } from "@midday/db/client";
import { electInboxGroupPrimary } from "@midday/db/queries";
import { inbox } from "@midday/db/schema";
import { inboxTypeFromFileName } from "@midday/documents";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

type Row = {
  id: string;
  teamId: string;
  fileName: string | null;
  type: "invoice" | "expense" | "other" | null;
  createdAt: string;
  groupedInboxId: string | null;
};

async function main() {
  const write = process.argv.includes("--confirm");
  const db = await connectDb();

  const candidates = await db
    .select({
      id: inbox.id,
      teamId: inbox.teamId,
      fileName: inbox.fileName,
      type: inbox.type,
      createdAt: inbox.createdAt,
      groupedInboxId: inbox.groupedInboxId,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.type, "invoice"),
        or(isNull(inbox.status), ne(inbox.status, "deleted")),
      ),
    );

  const toRetype = (candidates as Row[]).filter(
    (row) => inboxTypeFromFileName(row.fileName) === "expense",
  );

  console.log(
    `${candidates.length} documents are typed invoice; ${toRetype.length} are named as a receipt.`,
  );

  if (toRetype.length === 0) {
    return;
  }

  // Every group one of them sits in. A row that is its own primary carries a
  // null `grouped_inbox_id`, so the group's key is the primary's id either way.
  const groupIds = [
    ...new Set(toRetype.map((row) => row.groupedInboxId ?? row.id)),
  ];

  const members = (await db
    .select({
      id: inbox.id,
      teamId: inbox.teamId,
      fileName: inbox.fileName,
      type: inbox.type,
      createdAt: inbox.createdAt,
      groupedInboxId: inbox.groupedInboxId,
    })
    .from(inbox)
    .where(
      and(
        or(
          inArray(inbox.id, groupIds),
          inArray(inbox.groupedInboxId, groupIds),
        ),
        or(isNull(inbox.status), ne(inbox.status, "deleted")),
      ),
    )) as Row[];

  const retyped = new Set(toRetype.map((row) => row.id));

  // The election, as it will read once the retyping has happened.
  const byGroup = new Map<string, Row[]>();
  for (const row of members) {
    const key = row.groupedInboxId ?? row.id;
    const asRetyped: Row = retyped.has(row.id)
      ? { ...row, type: "expense" }
      : row;
    byGroup.set(key, [...(byGroup.get(key) ?? []), asRetyped]);
  }

  const reElections = [...byGroup.entries()].flatMap(([key, group]) => {
    if (group.length < 2) {
      return [];
    }
    const primary = electInboxGroupPrimary(group as [Row, ...Row[]]);
    return primary.id === key ? [] : [{ group, primary }];
  });

  console.log(
    `${byGroup.size} groups contain one; ${reElections.length} would get a different primary.`,
  );

  if (!write) {
    console.log("Dry run. Nothing was written. Pass --confirm to write.");
    return;
  }

  await db
    .update(inbox)
    .set({ type: "expense" })
    .where(inArray(inbox.id, [...retyped]));

  console.log(`Retyped ${retyped.size} documents as expenses.`);

  for (const { group, primary } of reElections) {
    await db
      .update(inbox)
      .set({ groupedInboxId: null })
      .where(eq(inbox.id, primary.id));

    const rest = group.filter((row) => row.id !== primary.id).map((r) => r.id);

    if (rest.length > 0) {
      await db
        .update(inbox)
        .set({ groupedInboxId: primary.id })
        .where(inArray(inbox.id, rest));
    }
  }

  console.log(`Re-elected the primary of ${reElections.length} groups.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
