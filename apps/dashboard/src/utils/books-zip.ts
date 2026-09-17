/**
 * The zip of invoices for the accountant (FF-1581): which file goes where and
 * under what name, and the two text files that say what the zip holds and what
 * it does not.
 *
 * Pure — no fetching and no zipping — so every decision about the layout is here
 * and testable. `useDownloadBooksZip` does the downloading around it.
 *
 * Built from Midday's own records only. A page must not ask the books (FF-1498),
 * so "already in the books" means what Midday itself knows: a document pulled
 * from their archive, a document whose copy was, an invoice number the pull has
 * seen there, or a card payment whose `books_status` says settled.
 */

import { comparableInvoiceReference } from "@midday/utils/invoice-reference";

export type BooksZipPayment = {
  id: string;
  date: string;
  name: string;
  amount: number;
  currency: string;
  supplier: string | null;
  account: { name: string | null; isCard: boolean };
  booksStatus: string | null;
  files: {
    name: string;
    path: string[];
    /** Bytes, which is how the books' copy of the same file is recognised. */
    size: number | null;
    contentType: string;
    invoiceNumber: string | null;
    copyGroup: string | null;
    fromBooks: boolean;
    /** Some copy of this invoice was pulled from the books (FF-1583). */
    booksHaveIt: boolean;
  }[];
};

export type BooksZipOptions = {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  /**
   * Leave out what the books already have: the invoices they hold a copy of,
   * and the card payments they have settled. On by default, so the zip is what
   * the books still need (FF-1583).
   */
  leaveOutWhatTheBooksHave: boolean;
};

export type BooksZipFile = {
  payment: BooksZipPayment;
  file: BooksZipPayment["files"][number];
  zipPath: string;
  /** The books already hold this document: link it there, do not upload it. */
  alreadyInBooks: boolean;
  /**
   * False when the file carries no invoice number Midday could compare, so
   * nothing is known either way and it is handed over to be safe. Uploading a
   * second copy to the books is the harmful direction — they have no delete —
   * so this is said out loud in the overview rather than guessed.
   */
  checkedAgainstTheBooks: boolean;
};

export type BooksZipPlan = {
  files: BooksZipFile[];
  /** Payments of the period Midday holds no invoice for. */
  withoutInvoice: BooksZipPayment[];
  /** Card payments left out because the books settled them. */
  settledLeftOut: BooksZipPayment[];
  /** Invoices left out because the books already hold a copy. */
  inBooksLeftOut: {
    payment: BooksZipPayment;
    file: BooksZipPayment["files"][number];
  }[];
};

/**
 * The comparable form of every invoice number the books hold, ready to be asked
 * about one file at a time.
 *
 * Normalised with the one rule the Yuki integration uses, and numbers shorter
 * than the floor are dropped: a three-character match is as likely to be
 * somebody else's invoice.
 */
export function booksInvoiceNumberSet(numbers: readonly string[]): Set<string> {
  const comparable = new Set<string>();
  for (const number of numbers) {
    const normalised = comparableInvoiceReference(number);
    if (normalised && normalised.length >= MINIMUM_COMPARABLE_NUMBER) {
      comparable.add(normalised);
    }
  }
  return comparable;
}

/** The same floor `@midday/yuki` uses: the shortest real number seen is four. */
const MINIMUM_COMPARABLE_NUMBER = 4;

/**
 * Where to look for the books' copy of a file, by byte size.
 *
 * The last resort, for a file nobody can check by number: 38 of the 39 such
 * files in the first real download were byte-identical to a document the books
 * already held. Size only narrows the field — the download compares the bytes,
 * which is the one identifier that cannot be a coincidence.
 */
export function booksFilePathsBySize(
  files: readonly { path: string[]; size: number }[],
): Map<number, string[][]> {
  const bySize = new Map<number, string[][]>();
  for (const file of files) {
    const paths = bySize.get(file.size) ?? [];
    paths.push(file.path);
    bySize.set(file.size, paths);
  }
  return bySize;
}

/** Written first, so a spreadsheet reads the file as UTF-8. */
export const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const ALREADY_IN_BOOKS_FOLDER = "_Already in the books - link, do not upload";
const NO_SUPPLIER_FOLDER = "No supplier name";

export function booksZipName(options: BooksZipOptions): string {
  return `Invoices ${options.from} to ${options.to}.zip`;
}

export function planBooksZip(
  payments: readonly BooksZipPayment[],
  options: BooksZipOptions,
  /** Comparable numbers of the invoices the books hold; see {@link booksInvoiceNumberSet}. */
  booksNumbers: ReadonlySet<string> = new Set(),
): BooksZipPlan {
  const files: BooksZipFile[] = [];
  const withoutInvoice: BooksZipPayment[] = [];
  const settledLeftOut: BooksZipPayment[] = [];
  const inBooksLeftOut: BooksZipPlan["inBooksLeftOut"] = [];
  const usedPaths = new Set<string>();

  for (const payment of payments) {
    // Only a card payment carries an answer from the books; a payment from a
    // bank account carries nothing, so nothing about it can be left out on
    // that ground.
    if (
      options.leaveOutWhatTheBooksHave &&
      payment.account.isCard &&
      payment.booksStatus === "in_the_books"
    ) {
      settledLeftOut.push(payment);
      continue;
    }

    if (payment.files.length === 0) {
      withoutInvoice.push(payment);
      continue;
    }

    for (const { file, alreadyInBooks, checkedAgainstTheBooks } of documentsOf(
      payment,
      booksNumbers,
    )) {
      if (options.leaveOutWhatTheBooksHave && alreadyInBooks) {
        inBooksLeftOut.push({ payment, file });
        continue;
      }

      const folder = safe(payment.supplier ?? "") || NO_SUPPLIER_FOLDER;
      const base = `${alreadyInBooks ? `${ALREADY_IN_BOOKS_FOLDER}/` : ""}${folder}/${fileName(payment, file)}`;

      files.push({
        payment,
        file,
        zipPath: unique(base, extensionOf(file), usedPaths),
        alreadyInBooks,
        checkedAgainstTheBooks,
      });
    }
  }

  return { files, withoutInvoice, settledLeftOut, inBooksLeftOut };
}

/**
 * The files of one payment worth handing over, and whether the books hold each.
 *
 * The inbox groups an invoice that reached Midday twice — by mail and pulled
 * back from the books — and also an invoice with its own receipt. The two are
 * told apart by the invoice number: the books' copy of a number Midday also has
 * from the supplier is left out, and everything else in the group stays. A group
 * with any copy from the books is a document the books already hold.
 */
function documentsOf(
  payment: BooksZipPayment,
  booksNumbers: ReadonlySet<string>,
): {
  file: BooksZipPayment["files"][number];
  alreadyInBooks: boolean;
  checkedAgainstTheBooks: boolean;
}[] {
  return payment.files
    .filter(
      (file) =>
        !file.fromBooks ||
        !payment.files.some(
          (other) =>
            !other.fromBooks &&
            other.copyGroup === file.copyGroup &&
            sameNumber(other.invoiceNumber, file.invoiceNumber),
        ),
    )
    .map((file) => {
      const number = file.invoiceNumber
        ? comparableInvoiceReference(file.invoiceNumber)
        : null;
      const comparable =
        number && number.length >= MINIMUM_COMPARABLE_NUMBER ? number : null;

      return {
        file,
        // Three ways to know the books have it, in order of directness: the file
        // came from them; some copy of the document did (FF-1583); or its number
        // is one the pull has seen in their archive — which is the answer to
        // "what do I still have to upload?" when Midday's copy arrived first.
        alreadyInBooks:
          file.fromBooks ||
          file.booksHaveIt ||
          (comparable !== null && booksNumbers.has(comparable)),
        // A file with no usable number cannot be checked either way.
        checkedAgainstTheBooks:
          file.fromBooks || file.booksHaveIt || comparable !== null,
      };
    });
}

function sameNumber(a: string | null, b: string | null): boolean {
  const normalise = (value: string | null) =>
    value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return normalise(a) === normalise(b);
}

/** `2026-03-12 - EUR 17,38 - Cursor - invoice 0BB37ACA-0017` */
function fileName(
  payment: BooksZipPayment,
  file: BooksZipPayment["files"][number],
): string {
  const who = safe(payment.supplier ?? "") || safe(payment.name);
  const number = file.invoiceNumber ? ` ${safe(file.invoiceNumber)}` : "";

  return `${payment.date} - ${payment.currency} ${amountText(payment.amount)} - ${who} - ${kindOf(file.name)}${number}`;
}

/**
 * What the document is, read from its file name. Midday records no such thing,
 * and suppliers name these files plainly: `Receipt-2291-4410.pdf`, Slack's
 * "fair billing statement". Only a label — nothing is left out on it.
 */
function kindOf(name: string): string {
  if (/receipt|kwitantie|ontvangstbewijs|re[çc]u\b/i.test(name)) {
    return "receipt";
  }
  if (/statement|afschrift/i.test(name)) return "billing statement";
  return "invoice";
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/webp": ".webp",
};

function extensionOf(file: BooksZipPayment["files"][number]): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(file.name);
  if (match?.[1]) return `.${match[1].toLowerCase()}`;
  return EXTENSION_BY_TYPE[file.contentType] ?? "";
}

function unique(base: string, extension: string, used: Set<string>): string {
  let candidate = `${base}${extension}`;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base} (${n})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

/** Fit for a folder or file name on every system the zip may be opened on. */
function safe(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

/** `17,38` and `2.406,58`: how the amount reads to a Belgian accountant. */
function amountText(amount: number): string {
  const [whole = "0", cents = "00"] = Math.abs(amount).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${cents}`;
}

/**
 * `_Overview.csv`: one row per file. Semicolons, because the amounts carry a
 * decimal comma and a Belgian spreadsheet splits on semicolons; a byte-order
 * mark, so it reads the names as UTF-8.
 */
export function booksZipOverview(files: readonly BooksZipFile[]): string {
  const rows = [
    [
      "Supplier",
      "Payment date",
      "Amount",
      "Currency",
      "Card or account",
      "File",
      "Description",
      "Already in the books",
    ],
    ...files.map(
      ({ payment, zipPath, alreadyInBooks, checkedAgainstTheBooks }) => [
        payment.supplier ?? "",
        payment.date,
        amountText(payment.amount),
        payment.currency,
        payment.account.name ?? "",
        zipPath,
        payment.name,
        alreadyInBooks
          ? "yes"
          : checkedAgainstTheBooks
            ? "no"
            : "cannot tell - no invoice number",
      ],
    ),
  ];

  return `${BYTE_ORDER_MARK}${rows.map((row) => row.map(csvField).join(";")).join("\r\n")}\r\n`;
}

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * `_Not included.txt`: everything of the period the zip does not hold, and why,
 * so an empty folder is never mistaken for a supplier with nothing to send.
 */
export function booksZipNotIncluded(
  plan: BooksZipPlan,
  options: BooksZipOptions,
  download: {
    failed: readonly BooksZipFile[];
    duplicates: readonly BooksZipFile[];
    /** Files the books turned out to hold, the same bytes (FF-1583). */
    sameFileInBooks?: readonly BooksZipFile[];
    /** What the comparison against the books' files came to. */
    comparison?: {
      booksFiles: number;
      compared: number;
      withCandidates: number;
      unreadableCandidates: number;
    };
  },
): string {
  const paymentLine = (payment: BooksZipPayment) =>
    `${payment.date}  ${payment.currency} ${amountText(payment.amount)}  ${payment.supplier ?? NO_SUPPLIER_FOLDER}  (${payment.name})`;

  const sections: [string, string[]][] = [
    [
      "Payments with no invoice in Midday",
      plan.withoutInvoice.map(paymentLine),
    ],
    [
      "Invoices left out because the books already hold a copy",
      plan.inBooksLeftOut.map(
        ({ payment, file }) => `${paymentLine(payment)}  ${file.name}`,
      ),
    ],
    [
      "Card payments left out because the books have settled them",
      plan.settledLeftOut.map(paymentLine),
    ],
    [
      "Invoices left out because the books hold the same file",
      (download.sameFileInBooks ?? []).map((file) => file.zipPath),
    ],
    [
      "Files that could not be downloaded",
      download.failed.map((file) => file.zipPath),
    ],
    [
      "Identical copies left out",
      download.duplicates.map((file) => file.zipPath),
    ],
  ];

  const written = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `${title} (${lines.length})\n${lines.join("\n")}`);

  // Always said, even when it found nothing: "nothing was left out" and "the
  // comparison never ran" look identical in a folder listing, and only one of
  // them means the zip is right.
  const checked = download.comparison
    ? [
        "How this was checked against the books",
        `${download.comparison.compared} of the files here were compared with the ${download.comparison.booksFiles} files the books hold.`,
        `${download.comparison.withCandidates} had a file of the same size to compare with, and ${(download.sameFileInBooks ?? []).length} turned out to be the same file.`,
        ...(download.comparison.unreadableCandidates > 0
          ? [
              `${download.comparison.unreadableCandidates} of the books' files could not be read, so those could not be ruled out.`,
            ]
          : []),
      ].join("\n")
    : null;

  return [
    `Invoices for the books, ${options.from} to ${options.to}`,
    ...(written.length > 0
      ? written
      : ["Every payment of the period with an invoice is included."]),
    ...(checked ? [checked] : []),
  ].join("\n\n");
}
