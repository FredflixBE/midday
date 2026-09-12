/**
 * FF-1493 — run the purchase decision against the real books and print what it
 * concluded, without delivering anything.
 *
 *   set -a; . apps/api/.env; set +a; bun run --cwd packages/jobs verify-yuki
 *
 * This is the acceptance test the ticket asks for. `reportYukiDelivery` is the
 * exact function the `yuki-decide-delivery` task calls, with the same real text
 * extraction, so a green run here means the task will behave identically — the
 * only thing it does not exercise is Trigger's own wiring.
 *
 * **Read-only on every side.** Yuki operations are all on the read allowlist,
 * the database sees `SELECT` only, and storage is read through short-lived
 * signed URLs. Nothing is written anywhere, which is what makes it safe to
 * point at live books repeatedly.
 *
 * **It prints no supplier, no invoice number and no amount.** This repository is
 * public. Team and document ids are truncated for the same reason, and what
 * comes out is counts and reason codes — which is all you need to compare the
 * run against the ticket's prediction.
 */
import { closeDb, connectDb } from "@midday/db/client";
import { getTeamIdsWithApp } from "@midday/db/queries";
import { extractTextFromPdf } from "@midday/documents/pdf-text";
import { createClient } from "@midday/supabase/job";
import { YukiNotConnectedError } from "@midday/yuki";
import { YUKI_APP_ID, yukiClientForTeam } from "@midday/yuki/team";
import { reportYukiDelivery } from "../src/utils/yuki-delivery";

const short = (id: string) => `${id.slice(0, 8)}…`;
const SIGNED_URL_TTL_SECONDS = 600;

async function main() {
  const db = await connectDb();
  const supabase = createClient();

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

    const startedAt = Date.now();
    const report = await reportYukiDelivery({
      db,
      teamId,
      client,
      readDocumentText: async (document) => {
        const path = document.filePath?.join("/");
        if (!path) return null;
        if (document.contentType !== "application/pdf") return null;
        try {
          const { data } = await supabase.storage
            .from("vault")
            .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
          if (!data?.signedUrl) return null;
          return await extractTextFromPdf(data.signedUrl);
        } catch {
          return null;
        }
      },
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log(
      `  archive      ${report.archive.documents} documents, ${report.archive.folders} folders, ${report.archive.calls} calls`,
    );
    console.log(
      `  inbox        ${report.decisions.length} documents decided, ${report.textLayersRead.fetched} text layers read`,
    );
    console.log(`  took         ${seconds}s\n`);

    console.log("  What Midday would do\n");
    for (const [action, n] of Object.entries(report.counts)) {
      console.log(`    ${action.padEnd(16)} ${String(n).padStart(4)}`);
    }

    const reasons = Object.entries(report.reasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length > 0) {
      console.log("\n  Why, for the ones it did not send\n");
      for (const [reason, n] of reasons) {
        console.log(`    ${reason.padEnd(32)} ${String(n).padStart(4)}`);
      }
    }

    // The identifiers, so a spot check is possible without printing anything
    // about the supplier. An inbox id is enough to open the row in Midday.
    const sending = report.decisions.filter((d) => d.action === "send");
    if (sending.length > 0) {
      console.log(`\n  The ${sending.length} it would deliver (inbox ids)\n`);
      for (const decision of sending) {
        console.log(`    ${short(decision.id)}`);
      }
    }

    const attention = report.decisions.filter(
      (d) => d.action === "needs_attention",
    );
    if (attention.length > 0) {
      console.log(`\n  The ${attention.length} needing a person\n`);
      for (const decision of attention) {
        const shared =
          decision.sharedWith.length > 0
            ? ` with ${decision.sharedWith.map(short).join(", ")}`
            : "";
        console.log(`    ${short(decision.id)}  ${decision.reason}${shared}`);
      }
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(closeDb);
