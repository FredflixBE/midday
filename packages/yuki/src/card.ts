import type { YukiClient } from "./client";

/**
 * The business Mastercard, read out of the books (FF-1517).
 *
 * KBC does not share the card over open banking — its consent page offers the
 * current account and nothing else — so Midday sees only the monthly
 * settlement and never the charges behind it. Yuki has them one by one,
 * because the accountant receives the card statement every month.
 *
 * Everything here is a read of the general ledger. A card charge is one Yuki
 * booking with two lines: the **card line** on the card's own GL account, and
 * a **counterpart line** for whatever the money was spent on. Those two lines
 * are what this module pairs, and the pairing is what produces the status.
 *
 * The facts below were measured on a live Belgian domain on 2026-09-12, over
 * 2025-09-01 → 2026-09-12: 159 lines on the card account, 147 charges and 12
 * settlements, all 147 pairing cleanly, 68 of them still waiting for their
 * invoice — the same 68 `OutstandingCreditorItems` reports.
 */

/**
 * Yuki's own numeric sub-type for a GL account, from `GetGLAccountScheme`.
 *
 * These are **numbers, not labels**, and that is the entire point: the scheme's
 * `descripton` (Yuki's own spelling) is a display string in the session's
 * language, exactly like the outstanding-item type labels and the archive's
 * `TypeDescription`. A French-language session would answer differently.
 * Everything this module decides, it decides on the sub-type.
 */
export const YUKI_GL_SUBTYPES = {
  /** Suppliers — 440000 on the Belgian scheme. */
  creditor: "2",
  /** Internal transfers between the company's own accounts — 580000. */
  internalTransfer: "4",
  /** Current account — 550xxx. */
  currentAccount: "49",
  /** Savings account — 532000. */
  savingsAccount: "50",
  /** Deposit account — 530000. */
  depositAccount: "51",
  /** Credit card — 434xxx. This is the one a team links. */
  creditCard: "52",
} as const;

/**
 * The accounts that hold the company's **own** money.
 *
 * A card line whose counterpart is one of these is not a purchase: it is the
 * card balance being paid off, or money moving between two of the company's
 * accounts. Importing those as transactions is how every charge ends up
 * counted twice, because the same movement is already on the current account.
 */
const OWN_MONEY_SUBTYPES: ReadonlySet<string> = new Set([
  YUKI_GL_SUBTYPES.internalTransfer,
  YUKI_GL_SUBTYPES.currentAccount,
  YUKI_GL_SUBTYPES.savingsAccount,
  YUKI_GL_SUBTYPES.depositAccount,
  YUKI_GL_SUBTYPES.creditCard,
]);

export interface YukiGLAccount {
  code: string;
  /** See {@link YUKI_GL_SUBTYPES}. `"0"` where Yuki classifies nothing. */
  subtype: string;
  /** Yuki spells this field `descripton` in its own response. */
  description: string;
  enabled: boolean;
}

type Raw = Record<string, unknown>;

function list(value: unknown): Raw[] {
  // A list of one comes back as the element itself, and an empty list as "".
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]) as Raw[];
}

/**
 * Yuki writes an absent value as `<x nil="true"/>`, which the parser turns into
 * `{ "@nil": "true" }` rather than leaving the field out.
 */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseGLAccountScheme(result: unknown): YukiGLAccount[] {
  return list((result as { GlAccount?: unknown })?.GlAccount).map(
    (account) => ({
      code: String(account.code ?? ""),
      subtype: String(account.subtype ?? "0"),
      // `descripton` is Yuki's spelling. Read both, in case they ever fix it.
      description: String(account.descripton ?? account.description ?? ""),
      enabled: String(account.isEnabled) === "true",
    }),
  );
}

export async function fetchGLAccountScheme(
  client: YukiClient,
): Promise<YukiGLAccount[]> {
  return parseGLAccountScheme(
    await client.call("GetGLAccountScheme", {
      administrationID: client.administrationId,
    }),
  );
}

/**
 * The card accounts a team could link, found from the scheme rather than from
 * a hard-coded 434001.
 *
 * A fresh Belgian scheme ships 434000 as an unnamed placeholder — its
 * description is literally `(Reserved for credit card)`, parenthesised because
 * Yuki has nothing to call it yet. It is enabled and it is sub-type 52, so it
 * would otherwise be offered as a card to link. A name in parentheses is the
 * scheme's own label for an account nobody has used, so it is left out.
 */
export function findCardGLAccounts(
  scheme: readonly YukiGLAccount[],
): YukiGLAccount[] {
  return scheme.filter(
    (account) =>
      account.enabled &&
      account.subtype === YUKI_GL_SUBTYPES.creditCard &&
      !account.description.startsWith("("),
  );
}

export interface YukiLedgerLine {
  /** Stable per line, and the key a charge is imported under. */
  id: string;
  /**
   * The line's number within the booking. Two lines of one booking are
   * consecutive, and that adjacency is what pairs them — see
   * {@link readCardLedger}.
   */
  hID: number;
  /** `YYYY-MM-DD`, as Yuki dated the movement. */
  date: string;
  description: string;
  /** Euro, signed as Yuki booked it: a purchase on the card is negative. */
  amount: number;
  glAccountCode: string;
  /** The statement this line was booked from. Shared by the whole statement. */
  statementId?: string;
  /** When that statement reached Yuki — 2 to 36 days after the charge. */
  statementCreated?: string;
  /** Present on the counterpart line once the accountant has named a supplier. */
  contactName?: string;
  /**
   * The currency the booking itself is in — the administration's own, not the
   * currency of the charge. See {@link YukiCardCharge.foreign}.
   */
  bookingCurrency?: string;
}

function nested(value: unknown): Raw | undefined {
  return value && typeof value === "object" ? (value as Raw) : undefined;
}

export function parseLedgerLines(result: unknown): YukiLedgerLine[] {
  return list((result as { Transaction?: unknown })?.Transaction).map(
    (line) => {
      const document = nested(line.document);
      const contact = nested(line.contact);
      const foreign = nested(line.foreignCurrency);

      return {
        id: String(line.id ?? ""),
        hID: Number(line.hID),
        // "2026-08-16T00:00:00" — the time is always midnight on a ledger line.
        date: String(line.transactionDate ?? "").slice(0, 10),
        description: String(line.description ?? ""),
        amount: Number(line.amount),
        glAccountCode: String(line.glAccountCode ?? ""),
        statementId: text(document?.["@id"]),
        statementCreated: text(document?.created),
        contactName: text(contact?.fullName),
        bookingCurrency: text(foreign?.currency),
      };
    },
  );
}

/**
 * Every ledger line in a window, across every account.
 *
 * It reads the whole ledger rather than just the card account because the
 * counterpart of a charge can sit anywhere: usually on suppliers, but two of
 * the 147 measured charges were booked straight to a cost account. Asking only
 * for the card account and for suppliers would leave those two unpaired, and
 * unpaired means *Needs attention* — a person asked to look at something that
 * is perfectly in order.
 *
 * The cost of reading everything is one call: a year of a small company's books
 * is 1,750 lines and under a megabyte, in well under a second.
 */
export async function fetchLedgerLines(
  client: YukiClient,
  window: { from: string; to: string },
): Promise<YukiLedgerLine[]> {
  return parseLedgerLines(
    await client.call("GetTransactions", {
      administrationID: client.administrationId,
      // ASMX validates parameters as an ordered sequence, and these names are
      // read off the published signature. A misspelling is not an error: Yuki
      // ignores the element and answers with the ledger entire, back to 2020.
      startDate: `${window.from}T00:00:00`,
      endDate: `${window.to}T00:00:00`,
      dataGroups: "document,contact,foreigncurrency",
    }),
  );
}

export interface YukiCardForeignAmount {
  /** ISO code as the card statement spelled it, e.g. `USD`. */
  currency: string;
  /** Signed like the euro amount: a purchase is negative. */
  amount: number;
  rate: number;
}

/**
 * What a card charge's description says, beyond the merchant.
 *
 * KBC writes the merchant twice with the original currency between the two
 * copies:
 *
 * ```
 * MASTERCARD - Kaartverrichtingen - EXAMPLE INC  NEW YORK  NY
 *   - Vreemde valuta: USD -29,00 Wisselkoers: 1,13 - EXAMPLE INC  NEW YORK  NY
 * ```
 *
 * The euro amount stays the one the ledger booked: that is what KBC actually
 * charged, rate and fees included, and it is more accurate than anything
 * recomputed from the original. The original is read for display only.
 *
 * Note that `foreignCurrency` on the line does **not** carry this. On all 159
 * measured card lines it answered `EUR` at rate 1.000000, including the 59
 * charges that were made in dollars — it describes the booking, not the card
 * transaction. The description is the only place the original survives.
 */
export interface YukiCardDescription {
  merchant: string;
  foreign?: YukiCardForeignAmount;
}

/** `-29,00` and `1,13` — a comma decimal separator, and no thousands group. */
function decimal(value: string): number {
  return Number(value.replace(",", "."));
}

const FOREIGN_AMOUNT =
  /Vreemde valuta:\s*([A-Z]{3})\s*(-?[\d.]+,\d+)\s*Wisselkoers:\s*(-?[\d.]+,\d+)/;

export function parseCardChargeDescription(
  description: string,
): YukiCardDescription {
  const segments = description.split(" - ");
  const foreignMatch = description.match(FOREIGN_AMOUNT);

  // "MASTERCARD - Kaartverrichtingen - <merchant> - …". The merchant is
  // repeated as the last segment, and padded with the alignment spaces the
  // card statement uses, which collapse to one.
  const merchant = (segments[2] ?? segments.at(-1) ?? description)
    .replace(/\s+/g, " ")
    .trim();

  if (!foreignMatch?.[1] || !foreignMatch[2] || !foreignMatch[3]) {
    return { merchant };
  }

  return {
    merchant,
    foreign: {
      currency: foreignMatch[1],
      amount: decimal(foreignMatch[2]),
      rate: decimal(foreignMatch[3]),
    },
  };
}

/**
 * Where a single card charge stands, as far as the books are concerned.
 *
 * The wording belongs to Midday, not to Yuki — nothing a person reads names
 * the accounting package (FF-1499).
 */
export type YukiCardChargeStatus =
  | "invoice_missing"
  | "in_the_books"
  | "needs_attention";

/** Why a charge could not be decided. Written for the person who has to look. */
export type YukiCardAttentionReason =
  | "no_counterpart_line"
  | "ambiguous_counterpart_line"
  | "description_differs"
  | "amount_differs";

export interface YukiCardCharge {
  /** The Yuki card line's id. Stable, and the key the charge is imported under. */
  id: string;
  date: string;
  /** The merchant, as the card statement wrote it. */
  merchant: string;
  /** The counterparty the accountant named, once they have named one. */
  contactName?: string;
  /** Euro, negative for a purchase. What KBC actually charged. */
  amount: number;
  /** The administration's own currency. `EUR` on every Belgian domain. */
  currency: string;
  /** The original amount, for a charge made in another currency. */
  foreign?: YukiCardForeignAmount;
  /** The statement this charge arrived on, and when it reached Yuki. */
  statementId?: string;
  statementCreated?: string;
  status: YukiCardChargeStatus;
  attentionReason?: YukiCardAttentionReason;
  /** The full description Yuki holds, kept for the attention list. */
  description: string;
}

/** The card balance being paid off from the current account. Not a purchase. */
export interface YukiCardSettlement {
  id: string;
  date: string;
  /** Positive: the card debt going down. */
  amount: number;
  description: string;
}

export interface YukiCardLedger {
  charges: YukiCardCharge[];
  settlements: YukiCardSettlement[];
  /** The newest date any line on the card account carries, or undefined. */
  reachesUpTo?: string;
}

export interface ReadCardLedgerParams {
  lines: readonly YukiLedgerLine[];
  /** The GL code of the card the team linked, e.g. `434001`. */
  cardAccountCode: string;
  scheme: readonly YukiGLAccount[];
  /**
   * The ids of the items `OutstandingCreditorItems` still lists — a payment
   * there is a payment the books have no invoice for.
   */
  outstandingItemIds: ReadonlySet<string>;
}

/**
 * Splits a card account's ledger lines into charges and settlements, and says
 * where each charge stands.
 *
 * **How a charge is paired.** The two lines of one booking share a statement
 * and are numbered consecutively, the counterpart one above the card line.
 * That adjacency is observed rather than documented, so it is not trusted on
 * its own: the pair must also carry an identical description and exactly
 * opposite amounts. Both lines come from one Yuki booking, so this is a
 * consistency check on a single source, not a comparison across systems — and
 * any failed check sends the charge to *Needs attention* rather than guessing.
 *
 * **How the status follows.** Once paired, the counterpart says everything:
 *
 * - it is on the supplier account and still outstanding → **invoice missing**;
 * - it is on the supplier account and settled, or it was booked straight to a
 *   cost account → **in the books**;
 * - it is one of the company's own accounts → not a charge at all, but the
 *   monthly settlement.
 *
 * `documentMatched.matchDate` is empty on every line and is **not** an invoice
 * flag; it is deliberately not read.
 */
export function readCardLedger({
  lines,
  cardAccountCode,
  scheme,
  outstandingItemIds,
}: ReadCardLedgerParams): YukiCardLedger {
  const subtypeByCode = new Map(scheme.map((a) => [a.code, a.subtype]));

  const linesByStatement = new Map<string, YukiLedgerLine[]>();
  for (const line of lines) {
    if (!line.statementId) continue;
    const group = linesByStatement.get(line.statementId);
    if (group) group.push(line);
    else linesByStatement.set(line.statementId, [line]);
  }

  const cardLines = lines.filter(
    (line) => line.glAccountCode === cardAccountCode,
  );

  const charges: YukiCardCharge[] = [];
  const settlements: YukiCardSettlement[] = [];

  for (const cardLine of cardLines) {
    const siblings = cardLine.statementId
      ? (linesByStatement.get(cardLine.statementId) ?? [])
      : [];
    const adjacent = siblings.filter(
      (line) =>
        line.hID === cardLine.hID + 1 && line.glAccountCode !== cardAccountCode,
    );

    const parsed = parseCardChargeDescription(cardLine.description);
    const base = {
      id: cardLine.id,
      date: cardLine.date,
      merchant: parsed.merchant,
      amount: cardLine.amount,
      currency: cardLine.bookingCurrency ?? "EUR",
      foreign: parsed.foreign,
      statementId: cardLine.statementId,
      statementCreated: cardLine.statementCreated,
      description: cardLine.description,
    };

    const attention = (
      attentionReason: YukiCardAttentionReason,
      contactName?: string,
    ) => {
      charges.push({
        ...base,
        contactName,
        status: "needs_attention",
        attentionReason,
      });
    };

    if (adjacent.length === 0) {
      attention("no_counterpart_line");
      continue;
    }
    if (adjacent.length > 1) {
      attention("ambiguous_counterpart_line");
      continue;
    }

    const counterpart = adjacent[0] as YukiLedgerLine;

    // A settlement is recognised before the verification below, because it is
    // not a charge and must never be imported: its description differs from a
    // charge's in shape, and it is already in Midday from the current account.
    if (
      OWN_MONEY_SUBTYPES.has(subtypeByCode.get(counterpart.glAccountCode) ?? "")
    ) {
      settlements.push({
        id: cardLine.id,
        date: cardLine.date,
        amount: cardLine.amount,
        description: cardLine.description,
      });
      continue;
    }

    if (counterpart.description !== cardLine.description) {
      attention("description_differs", counterpart.contactName);
      continue;
    }
    if (counterpart.amount !== -cardLine.amount) {
      attention("amount_differs", counterpart.contactName);
      continue;
    }

    const awaitingInvoice =
      subtypeByCode.get(counterpart.glAccountCode) ===
        YUKI_GL_SUBTYPES.creditor && outstandingItemIds.has(counterpart.id);

    charges.push({
      ...base,
      contactName: counterpart.contactName,
      status: awaitingInvoice ? "invoice_missing" : "in_the_books",
    });
  }

  const dates = cardLines.map((line) => line.date).sort();

  return { charges, settlements, reachesUpTo: dates.at(-1) };
}
