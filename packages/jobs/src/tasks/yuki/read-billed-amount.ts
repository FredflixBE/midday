import { getDb } from "@jobs/init";
import { TIMEOUTS, withTimeout } from "@jobs/utils/timeout";
import { billedAmountCorrection } from "@jobs/utils/yuki-billed-amount";
import {
  getExchangeRate,
  getYukiInboxRowForBilledAmount,
  setYukiInboxBilledAmount,
} from "@midday/db/queries";
import { DocumentClient } from "@midday/documents";
import { createClient } from "@midday/supabase/job";
import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

/** Long enough for one extraction to fetch the file, and no longer. */
const SIGNED_URL_TTL_SECONDS = 600;

/**
 * Reads what a pulled invoice actually billed, and gives its inbox row that
 * currency and total when it differs from what Yuki booked (FF-1572).
 *
 * A pulled row's amount is the accountant's booked figure. For a foreign
 * invoice that is a conversion nobody paid — Cursor's $19.95 booked as €17.22,
 * shown beside a payment of €17.57 — and it was the second euro amount on the
 * transaction sheet. The invoice's own total exists only on the PDF, so this
 * runs the extraction the mailbox path already uses and lets
 * `billedAmountCorrection` decide whether to believe it.
 *
 * **It never re-runs the matcher.** Matching again over a row that already has
 * a suggestion would skip that suggestion's transaction — the matcher leaves out
 * transactions with one pending — and could replace a correct suggestion with a
 * worse one. The pull calls this *before* it matches, so new rows are matched on
 * the right figure from the start; for rows pulled earlier, the suggestion card
 * reads the amount off the row, so correcting the row is what corrects the
 * screen.
 *
 * Costs one extraction per row, which is why it skips a row already corrected
 * before fetching anything.
 */
export const yukiReadBilledAmount = schemaTask({
  id: "yuki-read-billed-amount",
  // The extraction's own ceiling is ten minutes; this leaves it room.
  maxDuration: 900,
  queue: { concurrencyLimit: 5 },
  schema: z.object({
    teamId: z.string().uuid(),
    inboxId: z.string().uuid(),
  }),
  run: async ({ teamId, inboxId }) => {
    const row = await getYukiInboxRowForBilledAmount(getDb(), {
      teamId,
      inboxId,
    });

    if (!row) return { inboxId, outcome: "not-a-pulled-row" as const };

    // Corrected already, by an earlier run: nothing to pay for twice.
    if (row.baseCurrency !== null) {
      return { inboxId, outcome: "already-corrected" as const };
    }

    const bookedCurrency = row.currency ?? "EUR";
    const path = row.filePath?.join("/");
    if (!path) return { inboxId, outcome: "no-file" as const };

    const supabase = createClient();
    const { data: signed } = await supabase.storage
      .from("vault")
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (!signed?.signedUrl) {
      return { inboxId, outcome: "no-file" as const };
    }

    const extracted = await withTimeout(
      new DocumentClient().getInvoiceOrReceipt({
        documentUrl: signed.signedUrl,
        mimetype: row.contentType ?? "application/pdf",
      }),
      TIMEOUTS.DOCUMENT_PROCESSING,
      `Reading the billed amount timed out after ${TIMEOUTS.DOCUMENT_PROCESSING}ms`,
    );

    const currency = extracted.currency?.trim().toUpperCase() ?? null;
    const rate =
      currency && /^[A-Z]{3}$/.test(currency)
        ? await getExchangeRate(getDb(), {
            base: currency,
            target: bookedCurrency,
          })
        : undefined;

    const decision = billedAmountCorrection({
      booked: { amount: row.amount, currency: bookedCurrency },
      extracted: {
        amount: extracted.amount ?? null,
        currency,
        taxAmount: extracted.tax_amount ?? null,
      },
      rateToBooked: rate?.rate,
    });

    if (!decision.correct) {
      // Said out loud for the one reason worth reading: an extraction that
      // disagrees with the accountant's own total by more than a year of
      // exchange-rate movement is a misread, and a person may want to look.
      if (decision.reason === "implausible") {
        logger.warn("An extracted total disagrees with the booked amount", {
          teamId,
          inboxId,
          currency,
        });
      }
      return { inboxId, outcome: decision.reason };
    }

    const changed = await setYukiInboxBilledAmount(getDb(), {
      teamId,
      inboxId,
      bookedCurrency,
      update: decision.update,
    });

    return {
      inboxId,
      outcome: changed
        ? ("corrected" as const)
        : ("changed-meanwhile" as const),
    };
  },
});
