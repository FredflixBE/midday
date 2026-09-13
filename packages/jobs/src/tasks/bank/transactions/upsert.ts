import { getDb } from "@jobs/init";
import { transformTransaction } from "@jobs/utils/transform";
import { fillTransactionIdentifiers } from "@midday/db/queries";
import { createClient } from "@midday/supabase/job";
import { logger, schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { enrichTransactions } from "../../transactions/enrich-transaction";

const transactionSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  method: z.string().nullable(),
  date: z.string(),
  name: z.string(),
  status: z.enum(["pending", "posted"]),
  counterparty_name: z.string().nullable(),
  merchant_name: z.string().nullable(),
  balance: z.number().nullable(),
  currency: z.string(),
  amount: z.number(),
  category: z.string().nullable(),
  // Optional, not just nullable: the Yuki card-charge sync sends none of these,
  // and a schema that demanded them would reject those runs outright.
  counterparty_iban: z.string().nullable().optional(),
  bank_transaction_code: z.string().nullable().optional(),
  bank_transaction_sub_code: z.string().nullable().optional(),
  entry_reference: z.string().nullable().optional(),
});

export const upsertTransactions = schemaTask({
  id: "upsert-transactions",
  maxDuration: 120,
  queue: {
    concurrencyLimit: 10,
  },
  schema: z.object({
    teamId: z.string().uuid(),
    bankAccountId: z.string().uuid(),
    manualSync: z.boolean().optional(),
    transactions: z.array(transactionSchema),
  }),
  run: async ({ transactions, teamId, bankAccountId, manualSync }) => {
    const supabase = createClient();

    try {
      // Transform transactions to match our DB schema
      const formattedTransactions = transactions.map((transaction) => {
        return transformTransaction({
          // @ts-expect-error - TODO: Fix types with drizzle
          transaction,
          teamId,
          bankAccountId,
          notified: manualSync,
        });
      });

      // Upsert transactions into the transactions table, skipping duplicates based on internal_id
      const { data: upsertedTransactions } = await supabase
        .from("transactions")
        // @ts-expect-error - TODO: Fix types with drizzle
        .upsert(formattedTransactions, {
          onConflict: "internal_id",
          ignoreDuplicates: true,
        })
        .select("id")
        .throwOnError();

      // The rows that upsert just skipped still want their identifiers. The
      // bank re-serves a rolling ~85 days and every transaction in it comes back
      // carrying its IBAN and ISO 20022 code — including ones stored long before
      // Midday kept them, from a payload that did not have them. Skipping the
      // row threw those away at the door, which is why FF-1557 believed these
      // fields could only fill forward.
      //
      // Only ever fills a hole: `fillTransactionIdentifiers` coalesces per
      // column and touches nothing else, so a category somebody chose and a
      // merchant name the enrichment worked out both survive — which is the
      // reason the upsert skips these rows in the first place.
      const filled = await fillTransactionIdentifiers(getDb(), {
        teamId,
        entries: formattedTransactions.map((transaction) => ({
          internalId: transaction.internal_id,
          counterpartyIban: transaction.counterparty_iban,
          bankTransactionCode: transaction.bank_transaction_code,
          bankTransactionSubCode: transaction.bank_transaction_sub_code,
          entryReference: transaction.entry_reference,
        })),
      });

      if (filled > 0) {
        logger.info("Filled identifiers on transactions already stored", {
          filled,
          teamId,
        });
      }

      const transactionIds = upsertedTransactions?.map((tx) => tx.id) || [];

      if (transactionIds.length > 0) {
        await enrichTransactions.trigger({
          transactionIds,
          teamId,
        });

        await tasks.trigger("match-transactions-bidirectional", {
          teamId,
          newTransactionIds: transactionIds,
        });

        logger.info("Triggered enrichment and matching", {
          transactionCount: transactionIds.length,
          teamId,
        });
      }
    } catch (error) {
      logger.error("Failed to upsert transactions", { error });

      throw error;
    }
  },
});
