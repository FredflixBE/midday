import { getDb } from "@jobs/init";
import { processBatch } from "@jobs/utils/process-batch";
import { getTransactionsByIds } from "@midday/db/queries";
import { createClient } from "@midday/supabase/job";
import { download } from "@midday/supabase/storage";
import { ensureFileExtension } from "@midday/utils";
import {
  calculateBaseTaxAmount,
  getTaxTypeLabel,
  resolveTaxValues,
} from "@midday/utils/tax";
import { format, parseISO } from "date-fns";

const ATTACHMENT_BATCH_SIZE = 20;

/**
 * Build the rows and attachment blobs for a set of transactions.
 *
 * Shared by the two export tasks. This was a processor class in the worker,
 * but "process-export" was never dispatched as a job on its own — only ever
 * called in-process — so it is a plain function here.
 */
export async function processTransactionsForExport(params: {
  ids: string[];
  teamId: string;
  locale: string;
  dateFormat?: string | null;
  onProgress?: (progress: number) => Promise<void>;
}): Promise<{
  rows: unknown[][];
  attachments: Array<{
    id: string;
    name: string;
    blob: Blob | undefined;
  }>;
}> {
  const { ids, teamId, locale, dateFormat, onProgress } = params;
  const supabase = createClient(); // Keep for storage operations
  const db = getDb();

  if (onProgress) await onProgress(10);

  const transactionsData = await getTransactionsByIds(db, {
    ids,
    teamId,
  });

  if (onProgress) await onProgress(30);

  // Track global transaction index across batches to ensure unique rowId
  let globalTransactionIndex = 0;

  const attachments = await processBatch(
    transactionsData ?? [],
    ATTACHMENT_BATCH_SIZE,
    async (batch) => {
      const batchAttachments = await Promise.all(
        batch.flatMap((transaction) => {
          // Increment global index for each transaction (1-based)
          globalTransactionIndex += 1;
          const rowId = globalTransactionIndex;

          return (transaction.attachments ?? []).map(
            async (attachment, idx2: number) => {
              const originalName = attachment.name || "attachment";

              // Only apply MIME type extension if we have a valid MIME type
              const nameWithExtension = attachment.type
                ? ensureFileExtension(originalName, attachment.type)
                : originalName;
              const baseFilename = nameWithExtension.replace(/\.[^.]*$/, "");

              // Extract extension properly - if no extension exists, use "bin"
              const parts = nameWithExtension.split(".");
              const extension = parts.length > 1 ? parts.pop()! : "bin";

              const name =
                idx2 > 0
                  ? `${baseFilename}-${rowId}_${idx2}.${extension}`
                  : `${baseFilename}-${rowId}.${extension}`;

              const { data } = await download(supabase, {
                bucket: "vault",
                path: (attachment.path ?? []).join("/"),
              });

              return {
                id: transaction.id,
                name,
                blob: data ?? undefined,
              };
            },
          );
        }),
      );

      return batchAttachments.flat();
    },
  );

  if (onProgress) await onProgress(70);

  const rows = transactionsData
    ?.sort((a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime())
    .map((transaction) => {
      const { taxAmount, taxRate, taxType } = resolveTaxValues({
        transactionAmount: transaction.amount,
        transactionTaxAmount: transaction.tax_amount,
        transactionTaxRate: transaction.tax_rate,
        transactionTaxType: transaction.tax_type,
        categoryTaxRate: transaction.category?.tax_rate,
        categoryTaxType: transaction.category?.tax_type,
      });

      const formattedTaxType = getTaxTypeLabel(taxType ?? "");
      const formattedTaxRate = taxRate != null ? `${taxRate}%` : "";

      const hasBaseCurrency =
        transaction.base_amount != null &&
        transaction.base_currency &&
        transaction.base_currency !== transaction.currency;

      const baseTaxAmount = calculateBaseTaxAmount({
        amount: transaction.amount,
        taxAmount,
        taxRate,
        baseAmount: transaction.base_amount,
        baseCurrency: transaction.base_currency,
        currency: transaction.currency,
      });

      return [
        transaction.id,
        format(parseISO(transaction.date), dateFormat ?? "LLL dd, y"),
        transaction.name,
        transaction.description,
        transaction.amount,
        transaction.currency,
        Intl.NumberFormat(locale, {
          style: "currency",
          currency: transaction.currency,
        }).format(transaction.amount),
        hasBaseCurrency ? transaction.base_amount : "",
        hasBaseCurrency ? transaction.base_currency : "",
        formattedTaxType,
        formattedTaxRate,
        Intl.NumberFormat(locale, {
          style: "currency",
          currency: transaction.currency,
        }).format(taxAmount ?? 0),
        baseTaxAmount != null
          ? Intl.NumberFormat(locale, {
              style: "currency",
              currency: transaction.base_currency!,
            }).format(baseTaxAmount)
          : "",
        transaction?.counterparty_name ?? "",
        transaction?.category?.name ?? "",
        transaction?.category?.description ?? "",
        transaction?.category?.tax_reporting_code ?? "",
        transaction?.attachments?.length > 0 ||
        transaction?.status === "completed"
          ? "Completed"
          : "Not completed",
        attachments
          .filter((a) => a.id === transaction.id)
          .map((a) => a.name)
          .join(", ") ?? "",
        transaction?.balance ?? "",
        transaction?.bank_account?.name ?? "",
        transaction?.note ?? "",
        transaction?.tags?.map((t) => t.tag?.name).join(", ") ?? "",
      ];
    });

  if (onProgress) await onProgress(100);

  return {
    rows: rows ?? [],
    attachments: attachments ?? [],
  };
}
