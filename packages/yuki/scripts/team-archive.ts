/**
 * FF-1498 — read the archive the way Midday will, not the way the other
 * scripts do.
 *
 *   bun run --cwd packages/yuki team-archive
 *
 * `scripts/archive.ts` builds its client from `packages/yuki/.env`, which is
 * the one thing Midday may never do. Inside Midday a client comes from the
 * team's own `apps` row, with the access key decrypted at read time
 * (FF-1516) — so this exercises `getTeamIdsWithApp` → `yukiClientForTeam` →
 * `readYukiArchive`, which is the exact chain the first scheduled Yuki job
 * will run and which nothing had ever run end to end.
 *
 * It also checks the thing that is easy to get wrong about that chain: the
 * archive is reused per **client instance**, and `yukiClientForTeam` builds a
 * new client on every call. Ask it twice with one client and it reads once;
 * fetch a second client and it reads again.
 *
 * **It needs the database.** Both `DATABASE_URL` and `MIDDAY_ENCRYPTION_KEY`
 * must be set, and the key has to be the one the connection was encrypted
 * with or the row cannot be read back. Run it as:
 *
 *   set -a; . apps/api/.env; set +a; bun run --cwd packages/yuki team-archive
 *
 * Read-only on both sides: `SELECT` on `apps`, and Yuki operations that are
 * all on the read allowlist. It writes nothing and, like its sibling, prints
 * no supplier, amount or invoice number — this repository is public. Team ids
 * are truncated for the same reason.
 */
import { closeDb, connectDb } from "@midday/db/client";
import { getTeamIdsWithApp } from "@midday/db/queries";
import { readYukiArchive } from "../src/archive";
import { YukiNotConnectedError } from "../src/errors";
import { YUKI_APP_ID, yukiClientForTeam } from "../src/team";

/** Enough to tell two teams apart in a log, not enough to identify one. */
const short = (teamId: string) => `${teamId.slice(0, 8)}…`;

async function main() {
  const db = await connectDb();

  const teamIds = await getTeamIdsWithApp(db, YUKI_APP_ID);
  console.log(
    `${teamIds.length} team(s) have connected Yuki. A team without the app is never in this list, which is what stops one team's books being read for another.\n`,
  );

  if (teamIds.length === 0) {
    console.log(
      "Nothing to read. Connect Yuki for a team first, in the app store.",
    );
    return;
  }

  for (const teamId of teamIds) {
    try {
      const client = await yukiClientForTeam(db, teamId);

      const archive = await readYukiArchive(client);
      const invoices = archive.documents.filter((d) => d.referenceNormalized);

      console.log(
        `  ${short(teamId)}  ${archive.documents.length} documents in ${archive.folders.length} folders, ${archive.calls} calls, ${invoices.length} carrying a reference`,
      );

      // Asked again with the same client, it must not read again.
      const again = await readYukiArchive(client);
      console.log(
        again === archive
          ? `  ${short(teamId)}  asked twice with one client, read once — still ${again.calls} calls`
          : `  ${short(teamId)}  READ TWICE with one client — the per-run reuse is not working`,
      );

      // A second client is a second run, and must read again.
      const freshClient = await yukiClientForTeam(db, teamId);
      const freshArchive = await readYukiArchive(freshClient);
      console.log(
        freshArchive === archive
          ? `  ${short(teamId)}  a NEW client returned the OLD archive — reuse is outliving the run it belongs to`
          : `  ${short(teamId)}  a new client reads afresh, as a new run must`,
      );
    } catch (error) {
      if (error instanceof YukiNotConnectedError) {
        // The team disconnected between the list and the read. A real job
        // skips that team rather than failing the whole run.
        console.log(
          `  ${short(teamId)}  skipped: disconnected in the meantime`,
        );
        continue;
      }
      throw error;
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
