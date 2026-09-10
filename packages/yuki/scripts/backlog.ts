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
import { OUTSTANDING_ITEM_TYPE_LABELS } from "../src/types";

type OutstandingItem = {
  Date?: string;
  Contact?: string;
  Description?: string;
  OpenAmount?: string;
  Type?: { "#text"?: string } | string;
};

/**
 * The parser yields an array for several items, a bare object for exactly one,
 * and an empty string for none.
 */
function items(result: unknown): OutstandingItem[] {
  const container = (
    result as { OutstandingCreditorItems?: { Item?: unknown } }
  )?.OutstandingCreditorItems?.Item;
  if (!container) return [];
  return (
    Array.isArray(container) ? container : [container]
  ) as OutstandingItem[];
}

function typeLabel(item: OutstandingItem): string {
  return typeof item.Type === "string"
    ? item.Type
    : (item.Type?.["#text"] ?? "");
}

const PAYMENT_LABELS: ReadonlySet<string> = new Set([
  OUTSTANDING_ITEM_TYPE_LABELS.creditCardPayment,
  OUTSTANDING_ITEM_TYPE_LABELS.bankTransaction,
]);

const KNOWN_LABELS: ReadonlySet<string> = new Set(
  Object.values(OUTSTANDING_ITEM_TYPE_LABELS),
);

/** Card-statement lines carry the merchant in the description, not a contact. */
function counterparty(item: OutstandingItem): string {
  if (item.Contact) return item.Contact;
  const merchant = item.Description?.match(
    /Kaartverrichtingen - ([A-Za-z][\w .&*-]{2,30}?)\s{2,}/,
  )?.[1];
  return (merchant ?? item.Description ?? "unknown").trim().slice(0, 34);
}

const euro = (n: number) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(
    n,
  );

async function main() {
  const client = new YukiClient(configFromEnv());
  const all = items(
    await client.call("OutstandingCreditorItems", {
      administrationID: client.administrationId,
      includeBankTransactions: true,
      sortOrder: "DateDesc",
    }),
  );

  // Fail loudly on a label we have not classified, rather than quietly counting
  // it as "not a payment" — the labels are localised display strings.
  const unknown = [...new Set(all.map(typeLabel))].filter(
    (label) => !KNOWN_LABELS.has(label),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognised outstanding-item type label(s): ${unknown.join(", ")}. The session language may differ from the one these were observed in — see OUTSTANDING_ITEM_TYPE_LABELS in src/types.ts.`,
    );
  }

  const payments = all.filter((item) => PAYMENT_LABELS.has(typeLabel(item)));
  const total = payments.reduce(
    (sum, item) => sum + Math.abs(Number(item.OpenAmount ?? 0)),
    0,
  );
  const dates = payments
    .map((item) => item.Date ?? "")
    .filter(Boolean)
    .sort();

  console.log("Payments in Yuki with no invoice attached\n");
  console.log(`  count      ${payments.length}`);
  console.log(`  value      ${euro(total)}`);
  if (dates.length > 0) {
    console.log(`  oldest     ${dates[0]}`);
    console.log(`  newest     ${dates[dates.length - 1]}`);
  }

  for (const label of PAYMENT_LABELS) {
    const n = payments.filter((item) => typeLabel(item) === label).length;
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
