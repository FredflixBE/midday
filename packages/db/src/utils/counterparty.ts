/**
 * How a counterparty is identified when something needs to treat several
 * payments as coming from the same party: the name the bank gave, or the
 * merchant name where it gave none, trimmed and lower-cased.
 *
 * Exact match, so it merges repeats and not near-misses — `Xerius` and `Xerius
 * Sociaal Verzekeringsfonds Vz` are two counterparties here. That is a
 * deliberate limit, not an oversight: merging spellings needs a real supplier
 * identity, which is FF-1555. Until then, this is a **presentation and recall
 * affordance** and never a financial claim. An odd grouping heading costs
 * nothing; a wrong supplier link would.
 *
 * One implementation, used by the categoriser's recall (FF-1554) and the
 * missing-invoices grouping (FF-1552). `getCategoriesByCounterparty` computes
 * the same expression in SQL, and the two have to agree.
 */
export function counterpartyKey(transaction: {
  counterpartyName: string | null;
  merchantName: string | null;
}): string | null {
  const named = transaction.counterpartyName ?? transaction.merchantName;
  const key = named?.trim().toLowerCase();

  return key ? key : null;
}
