/**
 * FF-1450 — say what a pull would do to the real books, without pulling
 * anything.
 *
 *   set -a; . apps/api/.env; set +a; bun run --cwd packages/jobs verify-yuki-pull
 *
 * `planYukiPull` is the exact function the `yuki-pull-purchase-invoices` task
 * plans with, over the same archive and the same inbox, so the numbers here are
 * the numbers a run would act on.
 *
 * **Read-only on every side.** Yuki's operations are all on the read allowlist,
 * the database sees `SELECT` only, and nothing is written to storage. That is
 * what makes it safe to point at live books repeatedly — and it is worth doing
 * before the first real run, because the first real run pulls a few hundred
 * documents into somebody's inbox.
 *
 * **It prints no supplier, no invoice number and no amount.** This repository
 * is public. What comes out is counts and dates.
 */

import { closeDb, connectDb } from "@midday/db/client";
import { getInboxRowsForYukiPull, getTeamIdsWithApp } from "@midday/db/queries";
import { YukiNotConnectedError } from "@midday/yuki";
import { readYukiArchive } from "@midday/yuki/archive";
import { fetchDocumentBinary } from "@midday/yuki/documents";
import { YUKI_APP_ID, yukiClientForTeam } from "@midday/yuki/team";
import { inboxFileName } from "../src/utils/inbox-sync";
import { DEFAULT_YUKI_PULL_CUTOFF } from "../src/schemas/yuki";
import { planYukiPull } from "../src/utils/yuki-pull";

const short = (id: string) => `${id.slice(0, 8)}…`;

/** Cutoffs worth seeing side by side before one of them is chosen. */
const CUTOFFS = ["2026-01-01", DEFAULT_YUKI_PULL_CUTOFF, "2000-01-01"];

async function main() {
  const db = await connectDb();

  const teamIds = await getTeamIdsWithApp(db, YUKI_APP_ID);
  if (teamIds.length === 0) {
    console.log("No team has connected Yuki. Connect it in the app store.");
    return;
  }

  for (const teamId of teamIds) {
    console.log(`\n━━━ team ${short(teamId)} ━━━\n`);

    let client: Awaited<ReturnType<typeof yukiClientForTeam>>;
    try {
      client = await yukiClientForTeam(db, teamId);
    } catch (error) {
      if (error instanceof YukiNotConnectedError) {
        console.log("  not connected — the task would skip this team");
        continue;
      }
      throw error;
    }

    const [archive, inboxRows] = await Promise.all([
      readYukiArchive(client),
      getInboxRowsForYukiPull(db, { teamId }),
    ]);

    console.log(
      `  archive      ${archive.documents.length} documents, ${archive.folders.length} folders, ${archive.calls} calls`,
    );
    console.log(`  inbox        ${inboxRows.length} rows\n`);

    for (const cutoff of CUTOFFS) {
      // No limit, so the counts are the whole backlog rather than one run's
      // share of it.
      const plan = planYukiPull({
        archive,
        inboxRows,
        cutoff,
        limit: Number.MAX_SAFE_INTEGER,
      });
      const { counts } = plan;

      console.log(`  cutoff ${cutoff}`);
      console.log(
        `    purchase invoices ${counts.purchaseInvoices}  already pulled ${counts.alreadyPulled}  before cutoff ${counts.beforeCutoff}  undated ${counts.undated}`,
      );
      console.log(
        `    would pull ${counts.eligible}, of which ${counts.duplicates} group onto a document Midday already holds`,
      );
      if (plan.finish.length > 0) {
        console.log(
          `    ${plan.finish.length} pulled rows an earlier run left unfinished`,
        );
      }
      console.log("");
    }

    // One fetch, so the half of the job that is not a plan is exercised too:
    // the document really comes back, it really is a PDF, and the name it
    // would be stored under is one Storage accepts. Nothing is written.
    const [next] = planYukiPull({
      archive,
      inboxRows,
      cutoff: DEFAULT_YUKI_PULL_CUTOFF,
      limit: 1,
    }).pull;

    if (!next) {
      console.log("  nothing to fetch — the backlog is empty at this cutoff");
      continue;
    }

    const bytes = await fetchDocumentBinary(client, {
      documentId: next.document.documentId,
    });
    const fileName = inboxFileName({
      filename: next.document.fileName ?? `${next.document.documentId}.pdf`,
      mimeType: next.document.contentType ?? "application/pdf",
      referenceId: next.document.documentId,
    });

    console.log(
      `  fetch check  ${bytes.byteLength} bytes, ${Buffer.from(bytes.subarray(0, 4)).toString() === "%PDF" ? "a PDF" : "NOT a PDF"}, stored as ${fileName.length} characters`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
