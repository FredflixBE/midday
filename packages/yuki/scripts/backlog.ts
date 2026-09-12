/**
 * Measures the purchase backlog: payments in Yuki that still have no invoice.
 *
 *   bun run --cwd packages/yuki backlog
 *
 * This is the scoreboard for the FF-1446 purchase pipeline, and since FF-1493
 * that is all it is — nothing decides what to send from this list. The count
 * should fall as invoices are fetched into Midday, delivered to the Postbus and
 * matched to their payment by Yuki's own matcher. It will not reach zero — some
 * receipts are simply gone — but a payment that is still here after its invoice
 * was delivered is the cross-check this exists for.
 *
 * Read-only. Prints to stdout and writes nothing.
 */
import { parseCardChargeDescription } from "../src/card";
import { YukiClient } from "../src/client";
import {
  fetchOutstandingCreditorItems,
  type YukiOutstandingItem,
} from "../src/outstanding";
import { configFromEnv } from "./env";

/**
 * Card-statement lines carry the merchant in the description, not a contact.
 *
 * This used to be a regex of its own, which stopped at the first run of two
 * spaces and so truncated any merchant with an internal double space —
 * "PRISMA DATA  INC." counted as "PRISMA DATA". It now uses the parser the
 * card import is built on (FF-1517), which splits on the description's own
 * segments and is tested against the foreign-currency shape as well.
 */
function counterparty(item: YukiOutstandingItem): string {
  if (item.contact) return item.contact;
  if (!item.description) return "unknown";

  return parseCardChargeDescription(item.description).merchant.slice(0, 34);
}

const euro = (n: number) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(
    n,
  );

async function main() {
  const client = new YukiClient(configFromEnv());

  // Throws on a type label it has not classified, rather than quietly counting
  // it as "not a payment" — the labels are localised display strings.
  const all = await fetchOutstandingCreditorItems(client);

  const payments = all.filter((i) => i.kind === "payment_awaiting_invoice");
  const total = payments.reduce(
    (sum, item) => sum + Math.abs(item.openAmount),
    0,
  );
  const dates = payments.map((item) => item.date).sort();

  console.log("Payments in Yuki with no invoice attached\n");
  console.log(`  count      ${payments.length}`);
  console.log(`  value      ${euro(total)}`);
  if (dates.length > 0) {
    console.log(`  oldest     ${dates[0]}`);
    console.log(`  newest     ${dates[dates.length - 1]}`);
  }

  const byLabel = new Map<string, number>();
  for (const item of payments) {
    byLabel.set(item.typeLabel, (byLabel.get(item.typeLabel) ?? 0) + 1);
  }
  for (const [label, n] of byLabel) {
    console.log(`  ${label.padEnd(20)} ${n}`);
  }

  const byCounterparty = new Map<string, number>();
  for (const item of payments) {
    const name = counterparty(item);
    byCounterparty.set(name, (byCounterparty.get(name) ?? 0) + 1);
  }

  console.log("\nBy counterparty\n");
  for (const [name, n] of [...byCounterparty].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${name}`);
  }

  console.log(
    `\nUnpaid purchase invoices (not a gap): ${all.length - payments.length}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
