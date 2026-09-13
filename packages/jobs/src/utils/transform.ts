import type { Transaction as ProviderTransaction } from "@midday/banking";
import { transactionInternalId } from "@midday/db/queries";
import type { Database } from "@midday/supabase/types";

/** The identifiers a bank payload carries and other sources do not. */
type ProviderIdentifierField =
  | "counterparty_iban"
  | "bank_transaction_code"
  | "bank_transaction_sub_code"
  | "entry_reference";

/**
 * What a foreign-currency charge originally cost. Optional for the same reason
 * as the identifiers above: a source that is not a bank payload may send none
 * of it. See `transactions` in the schema for the direction the rate is in
 * (FF-1560).
 */
type ForeignAmountField =
  | "original_amount"
  | "original_currency"
  | "exchange_rate";

/**
 * A provider transaction as the sync task received it. The identifiers are
 * optional rather than merely nullable, because a source that is not a bank
 * payload does not set them at all. See `transactions` in the schema for what
 * each one holds.
 */
type IncomingTransaction = Omit<
  ProviderTransaction,
  ProviderIdentifierField | ForeignAmountField
> &
  Partial<
    Pick<ProviderTransaction, ProviderIdentifierField | ForeignAmountField>
  >;

type TransformTransactionData = {
  transaction: IncomingTransaction;
  teamId: string;
  bankAccountId: string;
  notified?: boolean;
};

type Transaction = {
  name: string;
  internal_id: string;
  category_slug: string | null;
  bank_account_id: string;
  description: string | null;
  balance: number | null;
  currency: string;
  method: string | null;
  amount: number;
  team_id: string;
  date: string;
  status: "posted";
  notified?: boolean;
  counterparty_name: string | null;
  merchant_name: string | null;
  counterparty_iban: string | null;
  bank_transaction_code: string | null;
  bank_transaction_sub_code: string | null;
  entry_reference: string | null;
  original_amount: number | null;
  original_currency: string | null;
  exchange_rate: number | null;
};

export function transformTransaction({
  transaction,
  teamId,
  bankAccountId,
  notified,
}: TransformTransactionData): Transaction {
  return {
    name: transaction.name,
    description: transaction.description,
    date: transaction.date,
    amount: transaction.amount,
    currency: transaction.currency,
    method: transaction.method,
    internal_id: transactionInternalId(teamId, transaction.id),
    category_slug: transaction.category,
    bank_account_id: bankAccountId,
    balance: transaction.balance,
    team_id: teamId,
    counterparty_name: transaction.counterparty_name,
    merchant_name: transaction.merchant_name,
    counterparty_iban: transaction.counterparty_iban ?? null,
    bank_transaction_code: transaction.bank_transaction_code ?? null,
    bank_transaction_sub_code: transaction.bank_transaction_sub_code ?? null,
    entry_reference: transaction.entry_reference ?? null,
    // Carried through rather than dropped. These used to be read off the
    // payload and thrown away here, which is why the only record that a charge
    // was originally $18.60 was an English sentence in `description` (FF-1560).
    original_amount: transaction.original_amount ?? null,
    original_currency: transaction.original_currency ?? null,
    exchange_rate: transaction.exchange_rate ?? null,
    // We only support posted transactions for now
    status: "posted",
    // If the transactions are being synced manually, we don't want to notify
    // And using upsert, we don't want to override the notified value
    ...(notified ? { notified } : {}),
  };
}

export function getClassification(
  type: Database["public"]["Enums"]["account_type"],
) {
  switch (type) {
    case "credit":
      return "credit";
    default:
      return "depository";
  }
}
