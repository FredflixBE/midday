/**
 * FF-1537 — does anything identify a Yuki bank line as a Midday transaction?
 *
 *   set -a; . apps/api/.env; set +a; bun run --cwd packages/jobs verify-yuki-bank-join
 *
 * FF-1537 settled that nothing does, because the Yuki side names the
 * counterparty by contact GUID while Midday holds the bank's freeform text, and
 * comparing those two means matching a name against prose — the fuzzy
 * cross-system comparison this epic forbids itself.
 *
 * That reasoning is about **names**. It may not hold for **structured payment
 * references**. A Belgian structured communication is the same twelve digits on
 * both ends of a payment by construction, and Midday's own bank feed already
 * shows several transactions whose entire name is one — `074790286074` — plus
 * others carrying an invoice number inline. If Yuki's bank line carries the
 * same digits, that is an identifier join and not a fuzzy one.
 *
 * This script measures whether it does. It decides nothing.
 *
 * **On amounts and dates.** The epic bars them from *deciding* an action across
 * the two systems, and this script does not use them to decide anything: the
 * join is proposed on the reference alone. They appear only as a *check* on a
 * proposal the reference already made — which is how you find out whether a
 * candidate identifier is trustworthy, and is the opposite of matching on them.
 *
 * **Read-only on every side.** Every Yuki operation used is on the read
 * allowlist, and the database sees `SELECT` only.
 *
 * **It prints no supplier, no reference and no amount.** This repository is
 * public. What comes out is counts, lengths and dates.
 */

import { connectDb } from "@midday/db/client";
import { getTeamIdsWithApp } from "@midday/db/queries";
import { bankAccounts, transactions } from "@midday/db/schema";
import {
  fetchGLAccountScheme,
  fetchLedgerLines,
  YUKI_CARD_HISTORY_DAYS,
  type YukiLedgerLine,
  YukiNotConnectedError,
} from "@midday/yuki";
import { YUKI_APP_ID, yukiClientForTeam } from "@midday/yuki/team";
import { and, eq, gte, lte } from "drizzle-orm";

const short = (id: string) => `${id.slice(0, 8)}…`;

/**
 * What Yuki's bank line says, field by field.
 *
 * Yuki carries the raw SEPA/CODA payload, which is far richer than the single
 * line Enable Banking hands Midday, and the parts that identify a payment are
 * **labelled**. Reading them by label beats hunting for digit runs: the first
 * pass of this script looked for any run of ten or more digits and reported
 * that 159 of 166 bank lines had one, which was almost entirely the masked card
 * number — the same digits on every card payment, and the source of every
 * ambiguous match it found.
 */
const YUKI_REFERENCE_FIELDS: { label: string; pattern: RegExp }[] = [
  // The Belgian structured communication — twelve digits, printed by the payer.
  {
    label: "structured",
    pattern: /gestructureerde mededeling:\s*([0-9/+ ]{10,})/i,
  },
  // What the payer's own system called the batch or the order.
  { label: "customer-ref", pattern: /Klantreferentie:\s*([^|]+)/i },
  // A creditor reference printed in the free text, e.g. 0001/0001/BE/2502981850.
  {
    label: "creditor-ref",
    pattern: /\b(\d{4}\/\d{4}\/[A-Z]{2}\/\d{6,})/,
  },
];

/**
 * The SEPA creditor identifier, present on every direct debit.
 *
 * `Identificatiecode van de schuldeiser: BE92FLS0202239951`. It identifies the
 * *creditor*, not the payment — issued once to the company collecting the
 * money, and stable across every collection it ever makes. That makes it a
 * candidate supplier key rather than a transaction key, which is FF-1555's
 * problem rather than this one, but it is measured here because this is the
 * only place it has ever been seen.
 */
const SEPA_CREDITOR_ID = /Identificatiecode van de schuldeiser:\s*([A-Z0-9]+)/i;

/** Digits only, so `0001/0001/BE/25029` and `0001 0001 Be 25029` are one key. */
function digits(text: string): string {
  return text.replace(/[^0-9]/g, "");
}

/** Every labelled reference on a Yuki line, as a digits-only key. */
function yukiReferences(description: string): string[] {
  const found = new Set<string>();
  for (const field of YUKI_REFERENCE_FIELDS) {
    const value = description.match(field.pattern)?.[1];
    if (!value) continue;
    const key = digits(value);
    if (key.length >= MIN_REFERENCE_DIGITS) found.add(key);
  }
  return [...found];
}

/**
 * Midday has no labels — its name is one line of bank prose — so every long
 * digit run is a candidate, and the Yuki side is what makes a pair specific.
 */
function middayReferences(name: string): string[] {
  const found = new Set<string>();
  const whole = digits(name);
  if (whole.length >= MIN_REFERENCE_DIGITS) found.add(whole);
  for (const run of name.replace(/[^0-9]/g, " ").split(/\s+/)) {
    if (run.length >= MIN_REFERENCE_DIGITS) found.add(run);
  }
  return [...found];
}

/** A structured communication is twelve digits; allow a little either side. */
const MIN_REFERENCE_DIGITS = 10;

function histogram(label: string, values: number[]) {
  if (values.length === 0) {
    console.log(`  ${label}: none`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  console.log(
    `  ${label}: n=${values.length} min=${sorted[0]} p50=${at(0.5)} p90=${at(0.9)} max=${sorted[sorted.length - 1]}`,
  );
}

async function main() {
  // Reads and prints; writes nothing.
  const db = await connectDb({ readOnly: true });

  const teamIds = await getTeamIdsWithApp(db, YUKI_APP_ID);
  if (teamIds.length === 0) {
    console.log("No team has connected Yuki.");
    return;
  }

  for (const teamId of teamIds) {
    console.log(`\n━━━ team ${short(teamId)} ━━━\n`);

    let client: Awaited<ReturnType<typeof yukiClientForTeam>>;
    try {
      client = await yukiClientForTeam(db, teamId);
    } catch (error) {
      if (error instanceof YukiNotConnectedError) continue;
      throw error;
    }

    const to = new Date();
    const from = new Date(
      to.getTime() - YUKI_CARD_HISTORY_DAYS * 24 * 60 * 60 * 1000,
    );
    const window = {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
    console.log(`window ${window.from} → ${window.to}\n`);

    // ── Yuki's side ───────────────────────────────────────────────────────
    const scheme = await fetchGLAccountScheme(client);
    const lines = await fetchLedgerLines(client, window);

    const byAccount = new Map<string, YukiLedgerLine[]>();
    for (const line of lines) {
      const group = byAccount.get(line.glAccountCode) ?? [];
      group.push(line);
      byAccount.set(line.glAccountCode, group);
    }

    const creditorIds = new Set(
      lines
        .map((l) => l.description.match(SEPA_CREDITOR_ID)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    const withCreditorId = lines.filter((l) =>
      SEPA_CREDITOR_ID.test(l.description),
    ).length;

    console.log(`ledger lines: ${lines.length}`);
    console.log(
      `SEPA creditor ids: ${withCreditorId} lines carry one, ${creditorIds.size} distinct`,
    );
    console.log("busiest accounts:");
    for (const [code, group] of [...byAccount.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)) {
      const account = scheme.find((a) => a.code === code);
      const withRef = group.filter(
        (l) => yukiReferences(l.description).length > 0,
      ).length;
      console.log(
        `  ${code} ${String(account?.subtype ?? "?").padEnd(3)} lines=${String(group.length).padStart(4)} with a ${MIN_REFERENCE_DIGITS}+ digit run=${withRef}`,
      );
    }

    // ── Midday's side ─────────────────────────────────────────────────────
    const middayRows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        name: transactions.name,
        amount: transactions.amount,
        accountName: bankAccounts.name,
      })
      .from(transactions)
      .innerJoin(bankAccounts, eq(bankAccounts.id, transactions.bankAccountId))
      .where(
        and(
          eq(transactions.teamId, teamId),
          gte(transactions.date, window.from),
          lte(transactions.date, window.to),
        ),
      );

    const middayByReference = new Map<string, typeof middayRows>();
    let middayWithReference = 0;
    for (const row of middayRows) {
      const refs = middayReferences(row.name);
      if (refs.length > 0) middayWithReference += 1;
      for (const ref of refs) {
        const group = middayByReference.get(ref) ?? [];
        group.push(row);
        middayByReference.set(ref, group);
      }
    }

    console.log(
      `\nMidday transactions in window: ${middayRows.length}, with a ${MIN_REFERENCE_DIGITS}+ digit run: ${middayWithReference}`,
    );
    histogram(
      "reference length (Midday)",
      [...middayByReference.keys()].map((r) => r.length),
    );

    // ── The join test ─────────────────────────────────────────────────────
    console.log("\njoin on the reference alone, per Yuki account:");
    for (const [code, group] of [...byAccount.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      let proposed = 0;
      let ambiguous = 0;
      let amountAgrees = 0;
      let dateWithin7 = 0;

      for (const line of group) {
        const hits = yukiReferences(line.description).flatMap(
          (ref) => middayByReference.get(ref) ?? [],
        );
        const unique = new Map(hits.map((h) => [h.id, h]));
        if (unique.size === 0) continue;
        proposed += 1;
        if (unique.size > 1) {
          ambiguous += 1;
          continue;
        }
        const [match] = [...unique.values()];
        if (!match) continue;
        if (Math.abs(Math.abs(match.amount) - Math.abs(line.amount)) < 0.005) {
          amountAgrees += 1;
        }
        const days =
          Math.abs(
            new Date(match.date).getTime() - new Date(line.date).getTime(),
          ) / 86_400_000;
        if (days <= 7) dateWithin7 += 1;
      }

      if (proposed === 0) continue;
      console.log(
        `  ${code}: lines=${String(group.length).padStart(4)} proposed=${String(proposed).padStart(3)} ambiguous=${ambiguous} amount agrees=${amountAgrees} within 7d=${dateWithin7}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
