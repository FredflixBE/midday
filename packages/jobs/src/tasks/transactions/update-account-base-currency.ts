import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type UpdateAccountBaseCurrencyPayload,
  updateAccountBaseCurrencySchema,
} from "@jobs/schemas/transactions";
import {
  currenciesToConvert,
  planBaseCurrencyUpdate,
} from "@jobs/utils/base-currency";
import {
  bulkUpdateTransactionsBaseCurrency,
  getBankAccountTeamId,
  getExchangeRatesBatch,
  getTransactionsByAccountId,
  updateBankAccount,
} from "@midday/db/queries";
import { schemaTask } from "@trigger.dev/sdk";

/**
 * Updates base currency for a specific account
 * Updates account balance and all transactions for the account
 */
export class UpdateAccountBaseCurrencyProcessor extends BaseProcessor<UpdateAccountBaseCurrencyPayload> {
  async process(
    job: JobContext<UpdateAccountBaseCurrencyPayload>,
  ): Promise<void> {
    const { accountId, currency, balance, baseCurrency } = job.data;
    const db = getDb();

    this.logger.info("Starting update-account-base-currency job", {
      jobId: job.id,
      accountId,
      currency,
      baseCurrency,
    });

    const teamId = await getBankAccountTeamId(db, { id: accountId });

    if (!teamId) {
      throw new Error(`Account not found: ${accountId}`);
    }

    // Get all transactions for this account
    const transactionsData = await getTransactionsByAccountId(db, {
      accountId,
      teamId,
    });

    const transactions = transactionsData.map((transaction) => ({
      id: transaction.id,
      amount: Number(transaction.amount),
      currency: transaction.currency,
    }));

    // One lookup for every currency involved, the account's and its
    // transactions' alike - they are not always the same currency.
    const rates = await getExchangeRatesBatch(db, {
      pairs: currenciesToConvert({ currency, baseCurrency, transactions }).map(
        (base) => ({ base, target: baseCurrency }),
      ),
    });

    const update = planBaseCurrencyUpdate({
      currency,
      balance,
      baseCurrency,
      transactions,
      rateFor: (base) => rates.get(`${base}:${baseCurrency}`) ?? null,
    });

    if (update.missingRates.length > 0) {
      // Not a reason to stop: the currencies that do have a rate still
      // convert, and the ones that don't are left empty rather than guessed at.
      this.logger.warn("No exchange rate found, leaving base amount empty", {
        accountId,
        baseCurrency,
        currencies: update.missingRates,
      });
    }

    // Update account base balance and base currency
    await updateBankAccount(db, {
      id: accountId,
      teamId,
      baseBalance: update.baseBalance,
      baseCurrency,
    });

    // Bulk update transactions with base currency/amount
    await bulkUpdateTransactionsBaseCurrency(db, {
      transactions: update.transactions,
      teamId,
    });

    this.logger.info("Update account base currency completed", {
      accountId,
      currency,
      baseCurrency,
      transactionCount: update.transactions.length,
      convertedCount: update.transactions.filter((tx) => tx.baseAmount !== null)
        .length,
      teamId,
    });
  }
}

const processor = new UpdateAccountBaseCurrencyProcessor();

export const updateAccountBaseCurrency = schemaTask({
  id: "update-account-base-currency",
  schema: updateAccountBaseCurrencySchema,
  // Rewrites the base amount on every transaction in the account, so it needs
  // more room than the transactions queue's 5 minute stall window implied.
  maxDuration: 900,
  queue: { concurrencyLimit: 10 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "update-account-base-currency", payload, ctx),
});
