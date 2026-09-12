import { getDb } from "@jobs/init";
import {
  cardChargeWindow,
  countCharges,
  toBooksStatusEntries,
  toUpsertTransactions,
} from "@jobs/utils/yuki-card-charges";
import {
  getLatestCardChargeDate,
  getYukiCardConnections,
  markCardSettlementsAsInternal,
  markYukiCardSynced,
  setTransactionsBooksStatus,
} from "@midday/db/queries";
import {
  fetchGLAccountScheme,
  fetchLedgerLines,
  fetchOutstandingCreditorItems,
  readCardLedger,
} from "@midday/yuki";
import { YukiNotConnectedError, yukiClientForTeam } from "@midday/yuki/team";
import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { upsertTransactions } from "../bank/transactions/upsert";

/**
 * Brings one team's card charges in from the books (FF-1517).
 *
 * KBC will not share the business Mastercard over open banking, so Midday sees
 * only the monthly settlement and none of the charges behind it — 68 of the 81
 * payments the books are still waiting on an invoice for were card charges
 * nothing in Midday could see. The accountant does have them, one by one.
 *
 * Three reads of Yuki per run, whatever the team's size: the chart of
 * accounts, a year of ledger lines, and the outstanding creditor items. The
 * free allowance is a thousand calls a day.
 */
export const yukiSyncCardCharges = schemaTask({
  id: "yuki-sync-card-charges",
  maxDuration: 300,
  // One run per team at a time. The daily schedule cannot overlap itself, but
  // the Admin button and the connection's own sync button both start this too.
  queue: { concurrencyLimit: 1 },
  schema: z.object({
    teamId: z.string().uuid(),
    /** Sync one linked card rather than all of them. */
    connectionId: z.string().uuid().optional(),
  }),
  run: async ({ teamId, connectionId }) => {
    const db = getDb();

    const cards = await getYukiCardConnections(db, { teamId, connectionId });

    if (cards.length === 0) {
      // Not a failure. A team can have Yuki connected and no card linked yet,
      // which is every team's state until someone picks one from the + menu.
      logger.info("No Yuki card linked; nothing to sync", { teamId });
      return { skipped: "no_card_linked" as const };
    }

    // One client for the whole run, deliberately. Everything Yuki-shaped that
    // holds a result holds it against the client instance, and
    // `yukiClientForTeam` builds a new one on every call — so fetching a fresh
    // client per card would turn a handful of calls into a multiple of them.
    let client: Awaited<ReturnType<typeof yukiClientForTeam>>;
    try {
      client = await yukiClientForTeam(db, teamId);
    } catch (error) {
      if (error instanceof YukiNotConnectedError) {
        // The team disconnected Yuki between the fan-out and this run. Skip it
        // rather than failing the schedule for everyone else.
        logger.info("Team has no Yuki connection; skipping", { teamId });
        return { skipped: "not_connected" as const };
      }
      throw error;
    }

    const window = cardChargeWindow(new Date());

    const [scheme, lines, outstanding] = await Promise.all([
      fetchGLAccountScheme(client),
      fetchLedgerLines(client, window),
      fetchOutstandingCreditorItems(client),
    ]);

    const outstandingItemIds = new Set(
      outstanding
        .filter((item) => item.kind === "payment_awaiting_invoice")
        .map((item) => item.id),
    );

    const results = [];

    for (const card of cards) {
      const ledger = readCardLedger({
        lines,
        cardAccountCode: card.glAccountCode,
        scheme,
        outstandingItemIds,
      });

      const counts = countCharges(ledger.charges);

      // A first sync backfills a year at once. Notifying about every one of
      // those would be a hundred alerts about charges the owner made months
      // ago, so the backfill arrives already marked as notified — exactly what
      // a manual sync does, and for the same reason.
      const backfill =
        (await getLatestCardChargeDate(db, {
          teamId,
          bankAccountId: card.bankAccountId,
        })) === null;

      if (ledger.charges.length > 0) {
        await upsertTransactions.triggerAndWait({
          teamId,
          bankAccountId: card.bankAccountId,
          manualSync: backfill,
          transactions: toUpsertTransactions(ledger.charges),
        });
      }

      // Written after the import and separately from it, because the import
      // skips rows it already has: a charge's status moves every time the
      // accountant books an invoice against it, long after it first arrived.
      const statusesWritten = await setTransactionsBooksStatus(db, {
        teamId,
        entries: toBooksStatusEntries(ledger.charges),
      });

      // The bank took one lump sum from the current account to pay the card
      // off, and Midday already has that transaction. Left alone, every charge
      // would be counted twice.
      const settlements = await markCardSettlementsAsInternal(db, {
        teamId,
        cardBankAccountId: card.bankAccountId,
        settlements: ledger.settlements,
      });

      await markYukiCardSynced(db, { connectionId: card.id, teamId });

      logger.info("Synced a Yuki card", {
        teamId,
        glAccountCode: card.glAccountCode,
        ...counts,
        statusesWritten,
        settlements,
      });

      results.push({
        connectionId: card.id,
        name: card.name,
        ...counts,
        statusesWritten,
        settlementsMarked: settlements.marked,
        settlementsAmbiguous: settlements.ambiguous,
        reachesUpTo: ledger.reachesUpTo ?? null,
      });
    }

    return {
      cards: results.length,
      charges: results.reduce((sum, card) => sum + card.total, 0),
      invoiceMissing: results.reduce(
        (sum, card) => sum + card.invoiceMissing,
        0,
      ),
      inTheBooks: results.reduce((sum, card) => sum + card.inTheBooks, 0),
      needsAttention: results.reduce(
        (sum, card) => sum + card.needsAttention,
        0,
      ),
      settlementsMarked: results.reduce(
        (sum, card) => sum + card.settlementsMarked,
        0,
      ),
      reachesUpTo: results
        .map((card) => card.reachesUpTo)
        .filter((date): date is string => date !== null)
        .sort()
        .at(-1),
      perCard: results,
    };
  },
});
