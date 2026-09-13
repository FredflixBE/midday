import { expect, test } from "bun:test";
import { transformTransaction } from "./transform";

test("transformTransaction should correctly transform transaction data", () => {
  const mockTransaction = {
    id: "123456",
    name: "Coffee Shop",
    description: "Morning coffee",
    date: "2023-05-15",
    amount: 5.5,
    currency: "USD",
    method: "card_purchase",
    category: "meals" as const,
    balance: 100.5,
    status: "posted" as const,
    counterparty_name: "Spotify AB",
    merchant_name: null,
    currency_rate: null,
    currency_source: null,
  };

  const teamId = "team123";
  const bankAccountId = "account456";

  const result = transformTransaction({
    transaction: mockTransaction,
    teamId,
    bankAccountId,
  });

  expect(result).toEqual({
    name: "Coffee Shop",
    description: "Morning coffee",
    date: "2023-05-15",
    amount: 5.5,
    currency: "USD",
    method: "card_purchase",
    counterparty_name: "Spotify AB",
    merchant_name: null,
    internal_id: "team123_123456",
    category_slug: "meals",
    bank_account_id: "account456",
    balance: 100.5,
    team_id: "team123",
    status: "posted",
    counterparty_iban: null,
    bank_transaction_code: null,
    bank_transaction_sub_code: null,
    entry_reference: null,
  });
});

test("transformTransaction carries the provider identifiers onto the row", () => {
  const result = transformTransaction({
    transaction: {
      id: "2026061800123456",
      name: "Xerius Vzw",
      description: "Sociale bijdragen Q2",
      date: "2026-06-18",
      amount: -142.5,
      currency: "EUR",
      method: "other",
      category: null,
      balance: 4200,
      status: "posted" as const,
      counterparty_name: "Xerius Vzw",
      merchant_name: null,
      currency_rate: null,
      currency_source: null,
      counterparty_iban: "BE68539007547034",
      bank_transaction_code: "IDDT",
      bank_transaction_sub_code: "PMDD",
      entry_reference: "2026061800123456",
    },
    teamId: "team123",
    bankAccountId: "account456",
  });

  expect(result.counterparty_iban).toBe("BE68539007547034");
  expect(result.bank_transaction_code).toBe("IDDT");
  expect(result.bank_transaction_sub_code).toBe("PMDD");
  expect(result.entry_reference).toBe("2026061800123456");
});

test("transformTransaction nulls the identifiers a source cannot supply", () => {
  // A Yuki card charge comes from the books, not from a bank payload: there is
  // no IBAN behind a card and no SEPA code on a ledger line.
  const result = transformTransaction({
    transaction: {
      id: "yuki-charge-1",
      name: "Example Inc.",
      description: null,
      date: "2026-06-18",
      amount: -42,
      currency: "EUR",
      method: "card_purchase",
      category: null,
      balance: null,
      status: "posted" as const,
      counterparty_name: "Example Inc.",
      merchant_name: "Example Inc.",
      currency_rate: null,
      currency_source: null,
    },
    teamId: "team123",
    bankAccountId: "account456",
  });

  expect(result.counterparty_iban).toBeNull();
  expect(result.bank_transaction_code).toBeNull();
  expect(result.bank_transaction_sub_code).toBeNull();
  expect(result.entry_reference).toBeNull();
});

test("transformTransaction should handle null values correctly", () => {
  const mockTransaction2 = {
    id: "789012",
    name: "Unknown Transaction",
    description: null,
    date: "2023-05-16",
    amount: 10.0,
    currency: "EUR",
    method: "unknown",
    category: null,
    balance: null,
    status: "posted" as const,
    counterparty_name: null,
    merchant_name: null,
    currency_rate: null,
    currency_source: null,
  };

  const teamId = "team456";
  const bankAccountId = "account789";

  const result = transformTransaction({
    transaction: mockTransaction2,
    teamId,
    bankAccountId,
  });

  expect(result).toEqual({
    name: "Unknown Transaction",
    description: null,
    date: "2023-05-16",
    amount: 10.0,
    currency: "EUR",
    method: "unknown",
    internal_id: "team456_789012",
    category_slug: null,
    counterparty_name: null,
    merchant_name: null,
    bank_account_id: "account789",
    balance: null,
    team_id: "team456",
    status: "posted",
    counterparty_iban: null,
    bank_transaction_code: null,
    bank_transaction_sub_code: null,
    entry_reference: null,
  });
});
