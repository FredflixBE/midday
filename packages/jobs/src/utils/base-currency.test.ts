import { describe, expect, test } from "bun:test";
import {
  type ConvertibleTransaction,
  currenciesToConvert,
  getAccountBalance,
  getTransactionAmount,
  planBaseCurrencyUpdate,
} from "./base-currency";

// The rates that were in exchange_rates when FF-1476 was written.
const USD_TO_EUR = 0.85925219;
const EUR_TO_USD = 1.16379;

const rates: Record<string, number> = {
  "USD:EUR": USD_TO_EUR,
  "EUR:USD": EUR_TO_USD,
};

const rateFor = (base: string, baseCurrency: string) =>
  rates[`${base}:${baseCurrency}`] ?? null;

const tx = (
  id: string,
  amount: number,
  currency: string,
): ConvertibleTransaction => ({ id, amount, currency });

const baseAmountOf = (
  update: ReturnType<typeof planBaseCurrencyUpdate>,
  id: string,
) =>
  update.transactions.find((transaction) => transaction.id === id)?.baseAmount;

describe("currenciesToConvert", () => {
  test("includes the currencies of the transactions, not just the account's", () => {
    expect(
      currenciesToConvert({
        currency: "EUR",
        baseCurrency: "EUR",
        transactions: [tx("1", -20, "USD"), tx("2", -50, "EUR")],
      }),
    ).toEqual(["USD"]);
  });

  test("asks for each currency once", () => {
    const currencies = currenciesToConvert({
      currency: "SEK",
      baseCurrency: "EUR",
      transactions: [
        tx("1", -20, "USD"),
        tx("2", -30, "USD"),
        tx("3", -40, "SEK"),
      ],
    });

    expect(currencies.sort()).toEqual(["SEK", "USD"]);
  });

  test("leaves out the base currency, which converts at parity", () => {
    expect(
      currenciesToConvert({
        currency: "EUR",
        baseCurrency: "EUR",
        transactions: [tx("1", -50, "EUR")],
      }),
    ).toEqual([]);
  });
});

describe("planBaseCurrencyUpdate", () => {
  test("converts a transaction at its own currency's rate, not the account's", () => {
    // FF-1476: a EUR account, a EUR base, and a USD transaction inside it. The
    // account's own rate is 1, and using it stored $20.00 as €20.00.
    const update = planBaseCurrencyUpdate({
      currency: "EUR",
      balance: 1000,
      baseCurrency: "EUR",
      transactions: [tx("usd", -20, "USD"), tx("eur", -50, "EUR")],
      rateFor: (base) => rateFor(base, "EUR"),
    });

    expect(baseAmountOf(update, "usd")).toBe(-17.19);
    expect(baseAmountOf(update, "eur")).toBe(-50);
    expect(update.baseBalance).toBe(1000);
  });

  test("still converts transactions that share the account's currency", () => {
    // The configuration that already worked, with the base set to USD.
    const update = planBaseCurrencyUpdate({
      currency: "EUR",
      balance: 1000,
      baseCurrency: "USD",
      transactions: [tx("usd", -20, "USD"), tx("eur", -50, "EUR")],
      rateFor: (base) => rateFor(base, "USD"),
    });

    expect(baseAmountOf(update, "usd")).toBe(-20);
    expect(baseAmountOf(update, "eur")).toBe(-58.19);
    expect(update.baseBalance).toBe(1163.79);
  });

  test("leaves the base amount empty when the rate is unknown", () => {
    const update = planBaseCurrencyUpdate({
      currency: "EUR",
      balance: 1000,
      baseCurrency: "EUR",
      transactions: [tx("eur", -50, "EUR"), tx("sek", -100, "SEK")],
      rateFor: (base) => rateFor(base, "EUR"),
    });

    expect(baseAmountOf(update, "eur")).toBe(-50);
    expect(baseAmountOf(update, "sek")).toBeNull();
  });

  test("converts what it has rates for when the account's own rate is missing", () => {
    const update = planBaseCurrencyUpdate({
      currency: "SEK",
      balance: 1000,
      baseCurrency: "EUR",
      transactions: [tx("usd", -20, "USD")],
      rateFor: (base) => rateFor(base, "EUR"),
    });

    expect(baseAmountOf(update, "usd")).toBe(-17.19);
    expect(update.baseBalance).toBeNull();
  });

  test("stamps the base currency on every transaction", () => {
    const update = planBaseCurrencyUpdate({
      currency: "EUR",
      balance: 1000,
      baseCurrency: "EUR",
      transactions: [tx("usd", -20, "USD"), tx("sek", -100, "SEK")],
      rateFor: (base) => rateFor(base, "EUR"),
    });

    expect(
      update.transactions.every(
        (transaction) => transaction.baseCurrency === "EUR",
      ),
    ).toBe(true);
  });
});

describe("a missing rate is not parity", () => {
  test("getTransactionAmount returns null rather than the unconverted amount", () => {
    expect(
      getTransactionAmount({
        amount: -20,
        currency: "USD",
        baseCurrency: "EUR",
        rate: null,
      }),
    ).toBeNull();
  });

  test("getAccountBalance returns null rather than the unconverted balance", () => {
    expect(
      getAccountBalance({
        currency: "USD",
        balance: 1000,
        baseCurrency: "EUR",
        rate: null,
      }),
    ).toBeNull();
  });

  test("a currency that is already the base needs no rate at all", () => {
    expect(
      getTransactionAmount({
        amount: -20,
        currency: "EUR",
        baseCurrency: "EUR",
        rate: null,
      }),
    ).toBe(-20);

    expect(
      getAccountBalance({
        currency: "EUR",
        balance: 1000,
        baseCurrency: "EUR",
        rate: null,
      }),
    ).toBe(1000);
  });
});
