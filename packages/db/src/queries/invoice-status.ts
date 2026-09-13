import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import type { Database } from "../client";
import {
  type booksStatusEnum,
  inbox,
  transactionAttachments,
  transactionCategories,
  transactionMatchSuggestions,
  transactions,
} from "../schema";
import { counterpartyKey } from "../utils/counterparty";
import { YUKI_INBOX_REFERENCE_PREFIX } from "./yuki-inbox";

/**
 * Where a transaction stands on its invoice, as far as **Midday's own records**
 * go (FF-1499).
 *
 * This is one of two answers a transaction carries. The other is
 * `transactions.books_status` — what the accountant's books say — and the two
 * are independent rather than steps on one path: on the live books a payment
 * can be settled by the accountant while Midday holds no document for it, and
 * can have a document in Midday that the accountant has never seen. Anything
 * that collapses them into a single ladder has to render one of those two cells
 * dishonestly, which is why they stay apart all the way to the screen.
 *
 * Derived rather than stored, every time. All three facts it reads — an
 * attachment row, a pending suggestion, the transaction's own status — are
 * Midday's own and cannot drift from themselves. `books_status` is stored
 * precisely because it is *not* Midday's own; see `booksStatusEnum`.
 */
export const INVOICE_STATUSES = [
  "invoice_missing",
  "invoice_pending",
  "invoice_attached",
  "no_invoice_needed",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * A document is filed against this transaction — on its own, *not* conflated
 * with `completed` the way `isFulfilled` is.
 */
export function hasAttachmentSql(teamId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionAttachments}
    WHERE ${transactionAttachments.transactionId} = ${transactions.id}
      AND ${transactionAttachments.teamId} = ${teamId}
  )`;
}

/** The matcher offered a document and nobody has answered yet. */
export function hasPendingSuggestionSql(teamId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionMatchSuggestions}
    WHERE ${transactionMatchSuggestions.transactionId} = ${transactions.id}
      AND ${transactionMatchSuggestions.teamId} = ${teamId}
      AND ${transactionMatchSuggestions.status} = 'pending'
  )`;
}

/**
 * What can have a supplier invoice at all.
 *
 * Money coming in has no supplier invoice to find, and neither does a transfer
 * between your own accounts: `internal` catches the pairs Midday recognised,
 * and the category answers for the rest — 4 own-account withdrawals on the live
 * books are in the second group only.
 *
 * ## Why the category is asked rather than named
 *
 * This used to compare the slug against `'transfer'`, one hardcoded name. That
 * left a VAT bill, an owner draw and a card settlement all reading as "Invoice
 * missing" — €28,454 of tax payments on the live books — and every new
 * exception would have been another slug in this expression. The categories now
 * carry the answer themselves (`can_have_supplier_invoice`), editable per
 * category, so nothing here needs to know their names.
 *
 * ## Why NOT EXISTS, rather than a join or a lookup
 *
 * The question is only ever *"has a category ruled this out?"*, and phrasing it
 * that way makes the safe default fall out: an uncategorised payment has a NULL
 * slug, nothing has ruled anything out, so it stays work. A join would drop it
 * silently — the same trap `IS DISTINCT FROM` was guarding against here before.
 *
 * This is the **only** place the flag is read. A supplier-level override
 * (FF-1555) belongs here too, as one more reason the answer can be no.
 *
 * Takes no `teamId`, unlike the two above: the category is matched to the
 * transaction's own team, which is stricter than any value a caller could pass
 * and is what the `(team_id, category_slug)` foreign key already guarantees. The
 * inner `transaction_categories` is the innermost scope, so it wins over any
 * join of the same table in the surrounding query.
 */
export function isExpenseSql(): SQL<boolean> {
  return sql<boolean>`(
    ${transactions.amount} < 0
    AND COALESCE(${transactions.internal}, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM ${transactionCategories}
      WHERE ${transactionCategories.teamId} = ${transactions.teamId}
        AND ${transactionCategories.slug} = ${transactions.categorySlug}
        AND ${transactionCategories.canHaveSupplierInvoice} = false
    )
  )`;
}

/**
 * The four values, in precedence order.
 *
 * **Null for anything that is not an expense.** Money coming in has no supplier
 * invoice, so "Invoice missing" would be a false alarm on every sale. Null means
 * the question does not apply, and the screen shows nothing.
 *
 * A filed document outranks everything: a transaction that has an attachment
 * *and* was marked done by hand is *Invoice attached*, because the document is
 * demonstrably there and "No invoice needed" would contradict it. `completed`
 * answers for the rest, which is how a bank fee leaves the work list for good.
 * A suggestion is last, so a document already filed is never described as one
 * still waiting to be confirmed — 1 transaction on the live books has both.
 */
export function invoiceStatusSql(teamId: string): SQL<InvoiceStatus | null> {
  return sql<InvoiceStatus | null>`CASE
    WHEN NOT ${isExpenseSql()} THEN NULL
    WHEN ${hasAttachmentSql(teamId)} THEN 'invoice_attached'
    WHEN ${transactions.status} = 'completed' THEN 'no_invoice_needed'
    WHEN ${hasPendingSuggestionSql(teamId)} THEN 'invoice_pending'
    ELSE 'invoice_missing'
  END`;
}

export type MissingInvoice = {
  id: string;
  date: string;
  name: string;
  amount: number;
  currency: string;
  /**
   * The accountant's answer, carried untouched and null wherever the books have
   * nothing to say. It earns a marker on the row and never a column: "your
   * accountant is waiting for this" has consequences, "we cannot tell yet" does
   * not (FF-1552).
   */
  booksStatus: (typeof booksStatusEnum.enumValues)[number] | null;
};

export type MissingInvoiceGroup = {
  /** The normalised counterparty, or null for the payments that name nobody. */
  key: string | null;
  /** The heading: the name as it was last written, or null for the no-name group. */
  name: string | null;
  count: number;
  /**
   * Per currency, never summed across them. A group's money is only ever a
   * decomposable statement about its own rows.
   */
  totals: { currency: string; amount: number }[];
  transactions: MissingInvoice[];
};

export type MissingInvoices = {
  groups: MissingInvoiceGroup[];
  /** The sum of the group counts, by construction. */
  count: number;
};

/**
 * Every payment still waiting for a supplier invoice, gathered by who was paid.
 *
 * ## Why grouped
 *
 * 125 rows on the live books are 31 counterparties. Fetching four Cursor
 * invoices is one errand, not four, and a flat list of 125 is a wall rather than
 * a to-do list. The grouping is a **presentation affordance** — see
 * `counterpartyKey` — and never a stored supplier link. If two spellings of one
 * supplier land under separate headings, the cost is an odd heading, not a wrong
 * financial claim.
 *
 * ## The no-name group
 *
 * Whatever names nobody goes in one group at the end rather than being dropped
 * or scattered. 26 of the 125 have no counterparty at all. This is where that is
 * visible, which is the rule the whole design runs under: an automatic answer
 * may be wrong as long as a person can see it.
 *
 * ## Why the count is computed here and not separately
 *
 * A number nobody can click into is a claim nobody can check. This returns the
 * groups and the total together, and the total is the sum of the groups — so
 * every number on the page decomposes into the rows underneath it.
 */
export async function getMissingInvoices(
  db: Database,
  params: { teamId: string },
): Promise<MissingInvoices> {
  const { teamId } = params;

  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      name: transactions.name,
      amount: transactions.amount,
      currency: transactions.currency,
      counterpartyName: transactions.counterpartyName,
      merchantName: transactions.merchantName,
      booksStatus: transactions.booksStatus,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, teamId),
        invoiceStatusFilterSql(teamId, ["invoice_missing"]),
      ),
    )
    // Newest first, then by id so the order — and therefore which spelling
    // becomes the heading — is the same on every run.
    .orderBy(desc(transactions.date), transactions.id);

  const byKey = new Map<string, MissingInvoiceGroup>();
  // The payments naming nobody, kept aside so they land last whatever their
  // number.
  const unnamed: MissingInvoice[] = [];

  for (const row of rows) {
    const key = counterpartyKey(row);
    // The names are what the grouping is made of; a row does not carry them on
    // to the screen, where the heading above it already says who was paid.
    const { counterpartyName, merchantName, ...transaction } = row;

    if (!key) {
      unnamed.push(transaction);
      continue;
    }

    const group = byKey.get(key);

    if (group) {
      group.transactions.push(transaction);
      continue;
    }

    byKey.set(key, {
      key,
      // The name as the most recent payment wrote it: rows are newest first, so
      // a supplier that has since been renamed reads as it does today. The same
      // first-non-blank rule `counterpartyKey` uses, so the heading is a name
      // from the party the key was built from.
      name: counterpartyName?.trim() || merchantName?.trim() || null,
      count: 0,
      totals: [],
      transactions: [transaction],
    });
  }

  const named = [...byKey.values()]
    .map(withCountAndTotals)
    // Biggest first: the most errands saved by one visit to one supplier portal.
    .sort(
      (a, b) => b.count - a.count || (a.name ?? "").localeCompare(b.name ?? ""),
    );

  const groups =
    unnamed.length > 0
      ? [
          ...named,
          withCountAndTotals({
            key: null,
            name: null,
            count: 0,
            totals: [],
            transactions: unnamed,
          }),
        ]
      : named;

  return {
    groups,
    count: groups.reduce((sum, group) => sum + group.count, 0),
  };
}

function withCountAndTotals(group: MissingInvoiceGroup): MissingInvoiceGroup {
  const byCurrency = new Map<string, number>();

  for (const transaction of group.transactions) {
    byCurrency.set(
      transaction.currency,
      (byCurrency.get(transaction.currency) ?? 0) + transaction.amount,
    );
  }

  return {
    ...group,
    count: group.transactions.length,
    totals: [...byCurrency.entries()].map(([currency, amount]) => ({
      currency,
      amount,
    })),
  };
}

/**
 * How many payments are waiting for an invoice, for the places that show a
 * number without the list — the overview card and the page heading.
 *
 * Deliberately the same predicate as `getMissingInvoices`, so the two cannot
 * disagree: a number on the overview that does not match the page it links to is
 * the exact failure FF-1499's first version cost trust on.
 */
export async function countMissingInvoices(
  db: Database,
  params: { teamId: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        invoiceStatusFilterSql(params.teamId, ["invoice_missing"]),
      ),
    );

  return row?.count ?? 0;
}

export function invoiceStatusFilterSql(
  teamId: string,
  statuses: InvoiceStatus[],
): SQL {
  return sql`${invoiceStatusSql(teamId)} IN (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;
}

/**
 * The inbox's own inbox-zero view: a document exists and nothing has been done
 * with it.
 *
 * ## Why "no transaction" is not the test
 *
 * A document with no transaction is not necessarily unfinished. Three reasons
 * it can be legitimately done, measured on the live inbox:
 *
 * - **It came from the books** (78). The accountant has it and has booked it.
 * - **It charges nothing** (21). No payment was ever going to appear.
 * - **It is not an invoice** (32).
 *
 * ## Judge the group, not the row
 *
 * When the pull found an invoice Midday already held, it filed the copy against
 * the original via `grouped_inbox_id`. So the finishing facts are checked across
 * every member of the group: today 4 rows sit at `pending`, `suggested_match`
 * or `analyzing` whose twin in the same group is already booked, and reading
 * rows one at a time shows all four as work that does not exist.
 */
export function inboxNeedsHandlingSql(): SQL {
  return sql`(
    ${inbox.status}::text NOT IN ('done', 'deleted', 'archived', 'no_charge', 'other')
    -- Exclude what is known *not* to be an invoice, rather than requiring that
    -- it is one: type is null until a document has been read, so demanding
    -- 'invoice' would hide everything that has only just arrived.
    AND ${inbox.type}::text IS DISTINCT FROM 'other' 
    AND NOT EXISTS (
      SELECT 1 FROM ${inbox} member
      WHERE (member.id = ${inbox.id} OR member.grouped_inbox_id = ${inbox.id})
        AND member.team_id = ${inbox.teamId}
        AND (
          member.transaction_id IS NOT NULL
          OR member.reference_id LIKE ${`${YUKI_INBOX_REFERENCE_PREFIX}%`}
        )
    )
  )`;
}

/** How much is left in the inbox's "Needs handling" view. */
export async function countInboxNeedsHandling(
  db: Database,
  params: { teamId: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        // The list only ever renders a group's primary row, so the count has to
        // agree with it or the tab promises work the list cannot show.
        isNull(inbox.groupedInboxId),
        inboxNeedsHandlingSql(),
      ),
    );

  return row?.count ?? 0;
}
