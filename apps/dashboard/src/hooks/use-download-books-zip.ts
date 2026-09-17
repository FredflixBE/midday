import { useMutation, useQueryClient } from "@tanstack/react-query";
import JSZip from "jszip";
import { useState } from "react";
import { saveFile } from "@/lib/save-file";
import { useTRPC } from "@/trpc/client";
import {
  type BooksZipFile,
  type BooksZipOptions,
  booksZipName,
  booksZipNotIncluded,
  booksZipOverview,
  planBooksZip,
} from "@/utils/books-zip";

/**
 * Signed URLs live for 60 seconds, so files are signed and fetched a few at a
 * time rather than all signed up front.
 */
const BATCH_SIZE = 8;

export type BooksZipResult = {
  included: number;
  failed: number;
  withoutInvoice: number;
  /** Files and payments left out because the books already have them. */
  leftOut: number;
};

/**
 * Downloads the zip of invoices for the accountant (FF-1581).
 *
 * Built in the browser from the files already in the Vault, as the other zip
 * downloads are, so nothing is copied or left behind on the server. What goes in
 * and under which name is `planBooksZip`; this only fetches and packs.
 */
export function useDownloadBooksZip() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const signedUrls = useMutation(trpc.documents.signedUrls.mutationOptions());

  const download = async (
    options: BooksZipOptions,
  ): Promise<BooksZipResult> => {
    try {
      const payments = await queryClient.fetchQuery({
        ...trpc.transactions.invoicesForBooks.queryOptions({
          from: options.from,
          to: options.to,
        }),
        staleTime: 0,
      });

      const plan = planBooksZip(payments, options);
      const zip = new JSZip();
      const kept: BooksZipFile[] = [];
      const failed: BooksZipFile[] = [];
      const duplicates: BooksZipFile[] = [];
      const seen = new Set<string>();

      setProgress({ done: 0, total: plan.files.length });

      for (let start = 0; start < plan.files.length; start += BATCH_SIZE) {
        const batch = plan.files.slice(start, start + BATCH_SIZE);
        const blobs = await fetchBatch(batch, (paths) =>
          signedUrls.mutateAsync(paths),
        );

        // In plan order, so which of two identical files is kept does not
        // depend on which download finished first.
        for (const [index, entry] of batch.entries()) {
          const blob = blobs[index];

          if (!blob) {
            failed.push(entry);
            continue;
          }

          // Identical bytes are one document, whatever the two rows say.
          const hash = await sha256(blob);
          if (seen.has(hash)) {
            duplicates.push(entry);
            continue;
          }

          seen.add(hash);
          zip.file(entry.zipPath, blob);
          kept.push(entry);
        }

        setProgress({
          done: Math.min(start + BATCH_SIZE, plan.files.length),
          total: plan.files.length,
        });
      }

      zip.file("_Overview.csv", booksZipOverview(kept));
      zip.file(
        "_Not included.txt",
        booksZipNotIncluded(plan, options, { failed, duplicates }),
      );

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      await saveFile(zipBlob, booksZipName(options));

      return {
        included: kept.length,
        failed: failed.length,
        withoutInvoice: plan.withoutInvoice.length,
        leftOut: plan.inBooksLeftOut.length + plan.settledLeftOut.length,
      };
    } finally {
      setProgress(null);
    }
  };

  return { download, progress, isPending: progress !== null };
}

/** The files of one batch, in order; null where one could not be fetched. */
async function fetchBatch(
  batch: readonly BooksZipFile[],
  sign: (paths: string[]) => Promise<string[]>,
): Promise<(Blob | null)[]> {
  const paths = batch.map((entry) => entry.file.path.join("/"));

  let urls: string[] = [];
  try {
    urls = await sign(paths);
  } catch {
    return batch.map(() => null);
  }

  return Promise.all(
    paths.map(async (path) => {
      // The route drops paths it could not sign, so the answer is matched back
      // by path rather than by position.
      const url = urls.find((candidate) =>
        decodeURIComponent(new URL(candidate).pathname).endsWith(
          `/vault/${path}`,
        ),
      );
      if (!url) return null;

      try {
        const response = await fetch(url);
        return response.ok ? await response.blob() : null;
      } catch {
        return null;
      }
    }),
  );
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
