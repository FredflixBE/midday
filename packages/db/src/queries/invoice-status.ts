import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import type { Database } from "../client";
import {
  bankAccounts,
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
 * `transactions.id`, spelled out.
 *
 * Interpolating the column instead lets drizzle decide how to render it, and it
 * only qualifies a reference when the surrounding query forces it to: in a
 * single-table select it emits a bare `"id"`, which inside these subqueries
 * binds to the subquery's own table and makes every `EXISTS` false. It is right
 * wherever the outer query joins something — and silently wrong where it does
 * not, which is the worst way for it to be wrong.
 *
 * Every caller selects `from transactions` without aliasing it, so writing the
 * table out is safe and correlates correctly in both shapes.
 */
const TRANSACTION_ID = sql`"transactions"."id"`;

/**
 * A document is filed against this transaction — on its own, *not* conflated
 * with `completed` the way `isFulfilled` is.
 */
export function hasAttachmentSql(teamId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionAttachments}
    WHERE ${transactionAttachments.transactionId} = ${TRANSACTION_ID}
      AND ${transactionAttachments.teamId} = ${teamId}
  )`;
}

/** The matcher offered a document and nobody has answered yet. */
export function hasPendingSuggestionSql(teamId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionMatchSuggestions}
    WHERE ${transactionMatchSuggestions.transactionId} = ${TRANSACTION_ID}
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
   * Midday has already found a likely invoice for this payment and is waiting
   * for somebody to say yes. One click away from done, so it belongs on this
   * list, marked, rather than hidden on another screen (FF-1552).
   */
  hasSuggestion: boolean;
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
  /** How many of `count` have an invoice suggested and waiting on a yes. */
  readyToConfirm: number;
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
  /** The sum of the group `readyToConfirm`s, likewise. */
  readyToConfirm: number;
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
 * The groups run alphabetically. Ordering them by size made a supplier's place
 * move every time a payment joined or left it, which at twenty suppliers is a
 * list you search rather than read (FF-1575).
 *
 * ## The no-name group
 *
 * Whatever names nobody goes in one group at the end rather than being dropped
 * or scattered. 26 of the 125 have no counterparty at all. This is where that is
 * visible, which is the rule the whole design runs under: an automatic answer
 * may be wrong as long as a person can see it.
 *
 * ## Why a suggested match is still on this list
 *
 * A payment Midday has found a likely invoice for has not got the invoice yet —
 * it is one click from done, not done. Leaving those off the page hid 41 of
 * them behind another screen, which for a list you work to zero is backwards:
 * they are the quickest thing on it. They are marked and counted separately, so
 * the page can say what is one click away and what is an errand. They keep
 * their place by date inside the group rather than jumping to its top
 * (FF-1576).
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
      hasSuggestion: hasPendingSuggestionSql(teamId).as("hasSuggestion"),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, teamId),
        invoiceStatusFilterSql(teamId, ["invoice_missing", "invoice_pending"]),
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
      readyToConfirm: 0,
      totals: [],
      transactions: [transaction],
    });
  }

  const named = [...byKey.values()]
    .map(withCountAndTotals)
    // Alphabetical, ignoring case, so a supplier is found where its name says
    // rather than where its count happens to put it today (FF-1575). The key
    // breaks a tie between two spellings that only differ in case.
    .sort(
      (a, b) =>
        (a.name ?? "").localeCompare(b.name ?? "", undefined, {
          sensitivity: "base",
        }) || (a.key ?? "").localeCompare(b.key ?? ""),
    );

  const groups =
    unnamed.length > 0
      ? [
          ...named,
          withCountAndTotals({
            key: null,
            name: null,
            count: 0,
            readyToConfirm: 0,
            totals: [],
            transactions: unnamed,
          }),
        ]
      : named;

  return {
    groups,
    count: groups.reduce((sum, group) => sum + group.count, 0),
    readyToConfirm: groups.reduce(
      (sum, group) => sum + group.readyToConfirm,
      0,
    ),
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
    readyToConfirm: group.transactions.filter((row) => row.hasSuggestion)
      .length,
    // Newest first, and nothing jumps the queue. Pulling suggestions to the top
    // broke the timeline of a monthly supplier — March above July above June —
    // and the marker already says which row is one click away (FF-1576). The
    // sort is stable, so equal dates keep the query's id order.
    transactions: [...group.transactions].sort((a, b) =>
      b.date.localeCompare(a.date),
    ),
    totals: [...byCurrency.entries()].map(([currency, amount]) => ({
      currency,
      amount,
    })),
  };
}

export type InvoiceForBooksFile = {
  name: string;
  /** Where the file is in the `vault` bucket. */
  path: string[];
  contentType: string;
  /** The invoice number of the inbox document this file came from, if any. */
  invoiceNumber: string | null;
  /**
   * The inbox group the document belongs to — the primary's id — or null for a
   * file uploaded straight onto the payment. Two files of one payment in the
   * same group are the same invoice reaching Midday twice, or an invoice and its
   * own receipt; the zip tells those apart, this only says they belong together.
   */
  copyGroup: string | null;
  /** The document was pulled from the books, so the books already hold it. */
  fromBooks: boolean;
  /**
   * Some document in the same copy group was pulled from the books, so the
   * books hold this invoice even though this file is Midday's own copy of it.
   *
   * Independent of whether that copy is attached to a payment, which is the
   * whole point: a document pulled back from the books is often matched to no
   * payment at all, and it still proves the books have the invoice (FF-1583).
   */
  booksHaveIt: boolean;
};

export type InvoiceForBooks = {
  id: string;
  date: string;
  /** The bank's description of the payment. */
  name: string;
  amount: number;
  currency: string;
  /** Who was paid, spelled as their newest payment in the period spells it. */
  supplier: string | null;
  account: { name: string | null; isCard: boolean };
  booksStatus: (typeof booksStatusEnum.enumValues)[number] | null;
  /** Empty when Midday holds no invoice for the payment. */
  files: InvoiceForBooksFile[];
};

/**
 * Every expense of a period that needs a supplier invoice, with the files
 * Midday holds for it — what the zip for the accountant is made of (FF-1581).
 *
 * Midday's own records only. A page must not ask the books (FF-1498), so
 * "already in the books" is what `books_status` says for a card payment and
 * nothing at all for a payment from a bank account.
 *
 * A payment marked as needing no invoice is left out; one still waiting for its
 * invoice is kept with no files, so the zip can say what it could not include.
 */
export async function getInvoicesForBooks(
  db: Database,
  params: { teamId: string; from: string; to: string },
): Promise<InvoiceForBooks[]> {
  const { teamId, from, to } = params;

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
      accountName: bankAccounts.name,
      accountType: bankAccounts.type,
    })
    .from(transactions)
    .leftJoin(bankAccounts, eq(bankAccounts.id, transactions.bankAccountId))
    .where(
      and(
        eq(transactions.teamId, teamId),
        gte(transactions.date, from),
        lte(transactions.date, to),
        invoiceStatusFilterSql(teamId, [
          "invoice_attached",
          "invoice_missing",
          "invoice_pending",
        ]),
      ),
    )
    // Newest first, so the first spelling met for a supplier is its newest —
    // the same rule the missing-invoices headings use.
    .orderBy(desc(transactions.date), transactions.id);

  if (rows.length === 0) return [];

  const files = await db
    .select({
      transactionId: transactionAttachments.transactionId,
      name: transactionAttachments.name,
      path: transactionAttachments.path,
      contentType: transactionAttachments.type,
      invoiceNumber: inbox.invoiceNumber,
      inboxId: inbox.id,
      groupedInboxId: inbox.groupedInboxId,
      referenceId: inbox.referenceId,
      booksHaveIt: sql<boolean>`EXISTS (
        SELECT 1 FROM ${inbox} AS books_copy
        WHERE books_copy.team_id = ${teamId}
          AND books_copy.reference_id LIKE ${`${YUKI_INBOX_REFERENCE_PREFIX}%`}
          AND COALESCE(books_copy.grouped_inbox_id, books_copy.id)
              = COALESCE(${inbox.groupedInboxId}, ${inbox.id})
      )`.as("booksHaveIt"),
    })
    .from(transactionAttachments)
    .leftJoin(
      inbox,
      and(
        eq(inbox.attachmentId, transactionAttachments.id),
        eq(inbox.teamId, teamId),
      ),
    )
    .where(
      and(
        eq(transactionAttachments.teamId, teamId),
        inArray(
          transactionAttachments.transactionId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(transactionAttachments.createdAt), transactionAttachments.id);

  const filesByPayment = new Map<string, InvoiceForBooksFile[]>();
  for (const file of files) {
    if (!file.transactionId) continue;
    const list = filesByPayment.get(file.transactionId) ?? [];
    list.push({
      name: file.name ?? "",
      path: file.path ?? [],
      contentType: file.contentType ?? "",
      invoiceNumber: file.invoiceNumber,
      copyGroup: file.inboxId ? (file.groupedInboxId ?? file.inboxId) : null,
      fromBooks:
        file.referenceId?.startsWith(YUKI_INBOX_REFERENCE_PREFIX) ?? false,
      booksHaveIt: file.booksHaveIt ?? false,
    });
    filesByPayment.set(file.transactionId, list);
  }

  const supplierByKey = new Map<string, string>();

  return rows.map((row) => {
    const key = counterpartyKey(row);
    if (key && !supplierByKey.has(key)) {
      supplierByKey.set(
        key,
        row.counterpartyName?.trim() || row.merchantName?.trim() || key,
      );
    }

    return {
      id: row.id,
      date: row.date,
      name: row.name,
      amount: row.amount,
      currency: row.currency,
      supplier: key ? (supplierByKey.get(key) ?? null) : null,
      account: { name: row.accountName, isCard: row.accountType === "credit" },
      booksStatus: row.booksStatus,
      files: filesByPayment.get(row.id) ?? [],
    };
  });
}

/**
 * Every invoice number Midday has seen on a document pulled from the books.
 *
 * This is how the zip knows what the books already hold without asking them: a
 * page must not call the accounting system (FF-1498), and the pull already
 * mirrors its archive into the inbox. Returned raw, and compared with
 * `comparableInvoiceReference` — one normaliser, or the drift between two shows
 * up as a duplicate upload.
 *
 * Bounded by what the pull has fetched: its cutoff is 2025-01-01 and each run
 * has a limit, so an invoice the books hold but the pull has not reached yet is
 * not in here. Run the pull before a download to keep this honest.
 */
export async function getBooksInvoiceNumbers(
  db: Database,
  params: { teamId: string },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ invoiceNumber: inbox.invoiceNumber })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        isNotNull(inbox.invoiceNumber),
        like(inbox.referenceId, `${YUKI_INBOX_REFERENCE_PREFIX}%`),
      ),
    );

  return rows
    .map((row) => row.invoiceNumber)
    .filter((number): number is string => number !== null);
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
        invoiceStatusFilterSql(params.teamId, [
          "invoice_missing",
          "invoice_pending",
        ]),
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
