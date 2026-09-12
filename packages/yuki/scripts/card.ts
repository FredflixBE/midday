/**
 * The acceptance test for FF-1517, against real books.
 *
 *   bun run --cwd packages/yuki card
 *
 * Finds the card accounts in the chart of accounts, reads a year of the ledger,
 * pairs every card charge with its counterpart line, and reports where each one
 * stands. Two numbers are the check:
 *
 *  - **nothing in Needs attention.** Every charge should pair, and the two that
 *    the first design could not pair were booked straight to a cost account
 *    rather than to suppliers — which is why the pairing looks at the adjacent
 *    line whatever account it landed on.
 *  - **invoice missing matches the backlog.** The charges this says have no
 *    invoice should be exactly the `Creditcardbetaling` items that
 *    `bun run --cwd packages/yuki backlog` counts, and it checks that here.
 *
 * Read-only: three calls, all on the read allowlist. Prints no merchant, no
 * supplier and no invoice number — this repository is public.
 */
import {
  fetchGLAccountScheme,
  fetchLedgerLines,
  findCardGLAccounts,
  readCardLedger,
  YUKI_CARD_HISTORY_DAYS,
  type YukiCardChargeStatus,
} from "../src/card";
import { YukiClient } from "../src/client";
import { fetchOutstandingCreditorItems } from "../src/outstanding";
import { OUTSTANDING_ITEM_TYPE_LABELS } from "../src/types";
import { configFromEnv } from "./env";

const euro = (n: number) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(
    n,
  );

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const client = new YukiClient(configFromEnv());

  const [scheme, lines, outstanding] = await Promise.all([
    fetchGLAccountScheme(client),
    fetchLedgerLines(client, {
      from: isoDaysAgo(YUKI_CARD_HISTORY_DAYS),
      to: isoDaysAgo(-1),
    }),
    fetchOutstandingCreditorItems(client),
  ]);

  const outstandingItemIds = new Set(
    outstanding
      .filter((item) => item.kind === "payment_awaiting_invoice")
      .map((item) => item.id),
  );

  const cards = findCardGLAccounts(scheme);

  console.log(
    `Chart of accounts: ${scheme.length} accounts, ${cards.length} of them a card\n`,
  );
  console.log(
    `Ledger: ${lines.length} lines over the last ${YUKI_CARD_HISTORY_DAYS} days`,
  );
  console.log(
    `Outstanding: ${outstandingItemIds.size} payments still waiting for an invoice\n`,
  );

  if (cards.length === 0) {
    console.log("No card account in this administration; nothing to read.");
    return;
  }

  const cardPaymentsOutstanding = outstanding.filter(
    (item) => item.typeLabel === OUTSTANDING_ITEM_TYPE_LABELS.creditCardPayment,
  ).length;

  let missingAcrossCards = 0;
  let attentionAcrossCards = 0;
  let heldBackAcrossCards = 0;

  for (const card of cards) {
    const ledger = readCardLedger({
      lines,
      cardAccountCode: card.code,
      scheme,
      outstandingItemIds,
    });

    const byStatus = new Map<YukiCardChargeStatus, number>();
    for (const charge of ledger.charges) {
      byStatus.set(charge.status, (byStatus.get(charge.status) ?? 0) + 1);
    }

    const missing = byStatus.get("invoice_missing") ?? 0;
    const attention = byStatus.get("needs_attention") ?? 0;
    missingAcrossCards += missing;
    attentionAcrossCards += attention;
    heldBackAcrossCards += ledger.undecidedCredits.length;

    const spent = ledger.charges.reduce(
      (sum, charge) => sum + Math.abs(charge.amount),
      0,
    );
    const foreign = ledger.charges.filter((charge) => charge.foreign).length;

    // The account's own name is the card holder's, so only the code is shown.
    console.log(`GL ${card.code}\n`);
    console.log(`  charges           ${ledger.charges.length}`);
    console.log(`  value             ${euro(spent)}`);
    console.log(`  in another currency ${foreign}`);
    console.log(
      `  settlements       ${ledger.settlements.length} (not imported)`,
    );
    console.log(
      `  held back         ${ledger.undecidedCredits.length} (money in, nothing explains it)`,
    );
    console.log(`  reaches up to     ${ledger.reachesUpTo ?? "—"}\n`);
    console.log(`  invoice missing   ${missing}`);
    console.log(`  in the books      ${byStatus.get("in_the_books") ?? 0}`);
    console.log(`  needs attention   ${attention}`);

    for (const charge of ledger.charges) {
      if (charge.status !== "needs_attention") continue;
      console.log(
        `    ${charge.date}  ${charge.attentionReason}  (line ${charge.id})`,
      );
    }

    console.log("");
  }

  console.log("Cross-checks\n");
  console.log(
    `  charges with no invoice        ${missingAcrossCards}\n` +
      `  card payments on the backlog   ${cardPaymentsOutstanding}`,
  );

  const agrees = missingAcrossCards === cardPaymentsOutstanding;
  console.log(
    agrees
      ? "  ✓ the two agree — every card payment the books are waiting on is a charge Midday can see"
      : "  ✗ they disagree — a payment the books are waiting on has no charge behind it, or the other way round",
  );
  console.log(
    attentionAcrossCards === 0
      ? "  ✓ every charge paired"
      : `  ✗ ${attentionAcrossCards} charges could not be decided; see above`,
  );
  console.log(
    heldBackAcrossCards === 0
      ? "  ✓ nothing arrived on the card that could not be explained"
      : `  ✗ ${heldBackAcrossCards} credits held back: each could be the monthly settlement`,
  );

  if (!agrees || attentionAcrossCards > 0 || heldBackAcrossCards > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
