import { type SQL, sql } from "drizzle-orm";

/**
 * How a counterparty is identified when something needs to treat several
 * payments as coming from the same party: the name the bank gave, or the
 * merchant name where it gave none, trimmed and lower-cased.
 *
 * Exact match, so it merges repeats and not near-misses — `Xerius` and `Xerius
 * Sociaal Verzekeringsfonds Vz` are two counterparties here. That is a
 * deliberate limit, not an oversight: merging spellings needs a real supplier
 * identity, which is the supplier link (FF-1555); this is what stands in for
 * it on a payment nothing has linked yet. A **presentation affordance** and
 * never a financial claim. An odd grouping heading costs nothing; a wrong
 * supplier link would.
 *
 * One implementation, used by the categoriser's grouping (FF-1554), supplier
 * recognition's grouping and the missing-invoices fallback (FF-1552).
 * `counterpartyKeySql` computes the same expression in SQL, and the two have to
 * agree.
 */
export function counterpartyKey(transaction: {
  counterpartyName: string | null;
  merchantName: string | null;
}): string | null {
  // The first name that is actually a name. `??` alone would let a counterparty
  // of `"  "` suppress a perfectly good merchant name, which on the live books
  // covers 279 of 288 expenses — so those payments would read as naming nobody.
  for (const named of [
    transaction.counterpartyName,
    transaction.merchantName,
  ]) {
    const key = named?.trim().toLowerCase();

    if (key) {
      return key;
    }
  }

  return null;
}

/**
 * The same key, computed in SQL, for a named `transactions` table or alias.
 *
 * `nullif` on each side rather than a plain coalesce: a counterparty of `"  "`
 * has to fall through to the merchant name here exactly as it does above, or
 * the two disagree about who a payment was to.
 *
 * Every column is spelled out with its table, which is the point of taking the
 * table's name rather than drizzle's column objects. Interpolating a column
 * lets drizzle decide how to qualify it, and in a single-table select it emits
 * a bare `"counterparty_name"` — which inside a correlated subquery binds to
 * the *subquery's* table and compares a row with itself. The name is always a
 * literal in this codebase, never user input.
 */
export function counterpartyKeySql(table: string): SQL<string | null> {
  return sql.raw(`coalesce(
    nullif(lower(trim("${table}"."counterparty_name")), ''),
    nullif(lower(trim("${table}"."merchant_name")), '')
  )`) as SQL<string | null>;
}
