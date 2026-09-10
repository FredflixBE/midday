type GetAccountBalanceParams = {
  currency: string;
  balance: number;
  baseCurrency: string;
  rate: number | null;
};

/**
 * A missing rate is not parity.
 *
 * These used to fall back to a rate of 1, which states that two currencies are
 * worth the same and stores a number nothing downstream can tell apart from a
 * converted one. Returning null leaves the base column empty, which reads as
 * what it is - unknown - and can be filled in once the rate arrives.
 */
export function getAccountBalance({
  currency,
  balance,
  baseCurrency,
  rate,
}: GetAccountBalanceParams): number | null {
  if (currency === baseCurrency) {
    return balance;
  }

  if (rate === null) {
    return null;
  }

  return +(balance * rate).toFixed(2);
}

type GetTransactionAmountParams = {
  amount: number;
  currency: string;
  baseCurrency: string;
  rate: number | null;
};

export function getTransactionAmount({
  amount,
  currency,
  baseCurrency,
  rate,
}: GetTransactionAmountParams): number | null {
  if (currency === baseCurrency) {
    return amount;
  }

  if (rate === null) {
    return null;
  }

  return +(amount * rate).toFixed(2);
}

export type ConvertibleTransaction = {
  id: string;
  amount: number;
  currency: string;
};

type AccountConversionParams = {
  /** The account's own currency. */
  currency: string;
  baseCurrency: string;
  transactions: ConvertibleTransaction[];
};

/**
 * Every currency an account's conversion needs a rate for.
 *
 * A transaction can be in a currency its account is not - a USD charge on a
 * EUR account - so the account's currency alone is not enough. The base
 * currency is left out: it converts at parity, and nothing needs to look it up.
 */
export function currenciesToConvert({
  currency,
  baseCurrency,
  transactions,
}: AccountConversionParams): string[] {
  const currencies = new Set([
    currency,
    ...transactions.map((transaction) => transaction.currency),
  ]);

  currencies.delete(baseCurrency);

  return [...currencies];
}

export type BaseCurrencyUpdate = {
  baseBalance: number | null;
  transactions: Array<{
    id: string;
    baseAmount: number | null;
    baseCurrency: string;
  }>;
  /** The currencies no rate was found for, so a caller can say so out loud. */
  missingRates: string[];
};

type PlanBaseCurrencyUpdateParams = AccountConversionParams & {
  balance: number;
  /** The rate from one currency to the base currency, null when unknown. */
  rateFor: (currency: string) => number | null;
};

/**
 * Work out the base amounts for an account and everything in it.
 *
 * Each transaction is converted at the rate for its own currency. Converting
 * them all at the account's rate is what FF-1476 was: a USD charge on a EUR
 * account, under a EUR base, was multiplied by the account's EUR-to-EUR rate
 * of 1 and stored as if $20.00 were €20.00.
 */
export function planBaseCurrencyUpdate({
  currency,
  balance,
  baseCurrency,
  transactions,
  rateFor,
}: PlanBaseCurrencyUpdateParams): BaseCurrencyUpdate {
  return {
    baseBalance: getAccountBalance({
      currency,
      balance,
      baseCurrency,
      rate: rateFor(currency),
    }),
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      baseAmount: getTransactionAmount({
        amount: transaction.amount,
        currency: transaction.currency,
        baseCurrency,
        rate: rateFor(transaction.currency),
      }),
      baseCurrency,
    })),
    missingRates: currenciesToConvert({
      currency,
      baseCurrency,
      transactions,
    }).filter((base) => rateFor(base) === null),
  };
}
