import { useMutation, useQueryClient } from "@tanstack/react-query";
import JSZip from "jszip";
import { useState } from "react";
import { saveFile } from "@/lib/save-file";
import { useTRPC } from "@/trpc/client";
import {
  type BooksZipFile,
  type BooksZipOptions,
  booksFilePathsBySize,
  booksInvoiceNumberSet,
  booksZipName,
  booksZipNotIncluded,
  booksZipOverview,
  planBooksZip,
  secondaryDocumentsCoveredByBooks,
} from "@/utils/books-zip";

/**
 * Signed URLs live for 60 seconds, so files are signed and fetched a few at a
 * time rather than all signed up front.
 */
const BATCH_SIZE = 8;

/**
 * What the download is doing.
 *
 * No count while it is checking: what is being counted there is documents being
 * compared against the books, most of which are then left out, and any number
 * shown at that point reads as the number of invoices to hand over. The count
 * appears when it is known and true — the invoices going into the zip (FF-1583).
 */
export type BooksZipProgress =
  | { phase: "checking" }
  | { phase: "packing"; invoices: number };

/** What comparing against the books' own files came to. */
export type BooksComparison = {
  /** Files the books hold, as the query reported them. */
  booksFiles: number;
  /** Files of the zip that were compared. */
  compared: number;
  /** Of those, how many had a books file of the same size to compare with. */
  withCandidates: number;
  /** Candidates whose bytes could not be read. */
  unreadableCandidates: number;
};

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
  const [progress, setProgress] = useState<BooksZipProgress | null>(null);

  const signedUrls = useMutation(trpc.documents.signedUrls.mutationOptions());

  /**
   * Whether the books hold this exact file. Compared on the bytes, never on a
   * size alone: 365 of the 387 pulled documents have a size of their own, so a
   * shared size is uncommon but not impossible, and a wrong answer here would
   * withhold an invoice the books never had.
   */
  const booksHoldTheSameFile = async (
    entry: BooksZipFile,
    hash: string,
    booksPathsBySize: Map<number, string[][]>,
    booksHashes: Map<string, string | null>,
    tally: BooksComparison,
  ): Promise<boolean> => {
    const candidates = booksPathsBySize.get(entry.file.size ?? -1) ?? [];
    if (candidates.length > 0) tally.withCandidates += 1;

    for (const path of candidates) {
      const key = path.join("/");
      if (!booksHashes.has(key)) {
        const blobs = await fetchBatch(
          [{ ...entry, file: { ...entry.file, path } }],
          (paths) => signedUrls.mutateAsync(paths),
        );
        const blob = blobs[0];
        booksHashes.set(key, blob ? await sha256(blob) : null);
        if (!blob) tally.unreadableCandidates += 1;
      }

      if (booksHashes.get(key) === hash) return true;
    }

    return false;
  };

  const download = async (
    options: BooksZipOptions,
  ): Promise<BooksZipResult> => {
    try {
      const { payments, booksInvoiceNumbers, booksFiles } =
        await queryClient.fetchQuery({
          ...trpc.transactions.invoicesForBooks.queryOptions({
            from: options.from,
            to: options.to,
          }),
          staleTime: 0,
        });

      const plan = planBooksZip(
        payments,
        options,
        booksInvoiceNumberSet(booksInvoiceNumbers),
      );
      const zip = new JSZip();
      // Downloaded and kept so far, written into the zip only once every
      // exclusion is decided. Removing an entry afterwards left its folder
      // behind, and a folder with nothing in it reads as a supplier whose
      // invoice went missing (FF-1583).
      const kept: { entry: BooksZipFile; blob: Blob }[] = [];
      const failed: BooksZipFile[] = [];
      const duplicates: BooksZipFile[] = [];
      const sameFileInBooks: BooksZipFile[] = [];
      const seen = new Set<string>();
      // The books' copies to compare bytes against, by size, and their hashes
      // once read — a size is often shared by one file, and the same one can
      // answer for several payments.
      // `?? []` so an API that predates this route's third field degrades to
      // "the comparison did not run", which _Not included.txt then says, rather
      // than throwing halfway through a download.
      const booksPathsBySize = options.leaveOutWhatTheBooksHave
        ? booksFilePathsBySize(booksFiles ?? [])
        : new Map<number, string[][]>();
      const booksHashes = new Map<string, string | null>();
      // What the comparison did, so the zip can say it rather than leave a
      // silent "nothing matched" to be guessed at.
      const comparison: BooksComparison = {
        booksFiles: booksFiles?.length ?? 0,
        compared: 0,
        withCandidates: 0,
        unreadableCandidates: 0,
      };

      setProgress({ phase: "checking" });

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

          // The last resort for a file no number could place: the books may
          // hold this very file. Only sizes they have are even looked at, so
          // this costs nothing for a file they cannot have (FF-1583).
          comparison.compared += 1;
          if (
            await booksHoldTheSameFile(
              entry,
              hash,
              booksPathsBySize,
              booksHashes,
              comparison,
            )
          ) {
            sameFileInBooks.push(entry);
            continue;
          }

          seen.add(hash);
          kept.push({ entry, blob });
        }
      }

      // Last: a receipt whose invoice the books already have is not something
      // to upload. Decided after the loop, because whether the invoice is in
      // the books is only known once its bytes have been compared (FF-1583).
      const covered = new Set(
        [
          ...plan.inBooksLeftOut.map(({ payment }) => payment.id),
          ...sameFileInBooks.map((entry) => entry.payment.id),
        ].filter(Boolean),
      );
      const secondaryLeftOut = options.leaveOutWhatTheBooksHave
        ? secondaryDocumentsCoveredByBooks(
            kept.map(({ entry }) => entry),
            covered,
          )
        : [];
      const written = kept.filter(
        ({ entry }) => !secondaryLeftOut.includes(entry),
      );

      for (const { entry, blob } of written) {
        zip.file(entry.zipPath, blob);
      }

      zip.file(
        "_Overview.csv",
        booksZipOverview(written.map(({ entry }) => entry)),
      );
      zip.file(
        "_Not included.txt",
        booksZipNotIncluded(plan, options, {
          failed,
          duplicates,
          sameFileInBooks,
          secondaryLeftOut,
          comparison,
        }),
      );

      setProgress({ phase: "packing", invoices: written.length });

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      await saveFile(zipBlob, booksZipName(options));

      return {
        included: written.length,
        failed: failed.length,
        withoutInvoice: plan.withoutInvoice.length,
        leftOut:
          plan.inBooksLeftOut.length +
          plan.settledLeftOut.length +
          sameFileInBooks.length +
          secondaryLeftOut.length,
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
