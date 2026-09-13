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
 * A provider transaction as the sync task received it. The identifiers are
 * optional rather than merely nullable, because a source that is not a bank
 * payload does not set them at all. See `transactions` in the schema for what
 * each one holds.
 */
type IncomingTransaction = Omit<ProviderTransaction, ProviderIdentifierField> &
  Partial<Pick<ProviderTransaction, ProviderIdentifierField>>;

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
