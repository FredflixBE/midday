import { useQueryState } from "nuqs";
import { createLoader, parseAsStringLiteral } from "nuqs/server";

/**
 * `missing` is FF-1499's inbox-zero view: the expense transactions that still
 * need a person. A row leaves it when the invoice is attached, the suggested
 * match is confirmed, or it is marked as needing no invoice — so working it
 * empties it, which is the whole point of having it.
 */
export const TRANSACTION_TABS = ["all", "missing", "review"] as const;

export type TransactionTabValue = (typeof TRANSACTION_TABS)[number];

export const transactionTabSchema = {
  tab: parseAsStringLiteral(TRANSACTION_TABS).withDefault("all"),
};

export function useTransactionTab() {
  const [tab, setTab] = useQueryState(
    "tab",
    parseAsStringLiteral(TRANSACTION_TABS).withDefault("all"),
  );

  return { tab, setTab };
}

export const loadTransactionTab = createLoader(transactionTabSchema);
