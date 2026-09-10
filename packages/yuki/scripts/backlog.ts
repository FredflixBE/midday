/**
 * Measures the purchase backlog: payments in Yuki that still have no invoice.
 *
 *   bun run --cwd packages/yuki backlog
 *
 * This is the acceptance test for the FF-1446 purchase pipeline. The count
 * should fall as SaaS invoices are fetched into Midday, uploaded to the Postbus
 * and matched by Yuki. It will not reach zero — some receipts are simply gone —
 * but every item the pipeline can resolve, it should.
 *
 * Read-only. Prints to stdout and writes nothing.
 */
import { YukiClient } from "../src/client";
import { configFromEnv } from "../src/config";
import {
  fetchOutstandingCreditorItems,
  type YukiOutstandingItem,
} from "../src/outstanding";

/** Card-statement lines carry the merchant in the description, not a contact. */
function counterparty(item: YukiOutstandingItem): string {
  if (item.contact) return item.contact;
  const merchant = item.description?.match(
    /Kaartverrichtingen - ([A-Za-z][\w .&*-]{2,30}?)\s{2,}/,
  )?.[1];
  return (merchant ?? item.description ?? "unknown").trim().slice(0, 34);
}

const euro = (n: number) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(
    n,
  );

async function main() {
  // Throws on an unrecognised type label rather than miscounting.
  const all = await fetchOutstandingCreditorItems(
    new YukiClient(configFromEnv()),
  );

  const payments = all.filter((i) => i.kind === "payment_awaiting_invoice");
  const total = payments.reduce((sum, i) => sum + Math.abs(i.openAmount), 0);
  const dates = payments.map((i) => i.date).sort();

  console.log("Payments in Yuki with no invoice attached\n");
  console.log(`  count      ${payments.length}`);
  console.log(`  value      ${euro(total)}`);
  if (dates.length > 0) {
    console.log(`  oldest     ${dates[0]}`);
    console.log(`  newest     ${dates[dates.length - 1]}`);
  }

  const byLabel = new Map<string, number>();
  for (const i of payments) {
    byLabel.set(i.typeLabel, (byLabel.get(i.typeLabel) ?? 0) + 1);
  }
  for (const [label, n] of byLabel) console.log(`  ${label.padEnd(20)} ${n}`);

  const byCounterparty = new Map<string, number>();
  for (const i of payments) {
    const name = counterparty(i);
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
