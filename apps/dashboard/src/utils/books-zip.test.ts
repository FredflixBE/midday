/**
 * The zip of invoices for the accountant (FF-1581): what goes where, what each
 * file is called, and what the two text files say.
 *
 * The layout is the one that worked by hand on 2026-09-16 — a folder per
 * supplier, and file names that carry the payment date and amount so each file
 * finds its payment.
 */
import { describe, expect, test } from "bun:test";
import {
  type BooksZipPayment,
  BYTE_ORDER_MARK,
  booksZipName,
  booksZipNotIncluded,
  booksZipOverview,
  planBooksZip,
} from "./books-zip";

const PERIOD = {
  from: "2026-01-01",
  to: "2026-06-30",
  leaveOutSettledCards: false,
};

function payment(overrides: Partial<BooksZipPayment>): BooksZipPayment {
  return {
    id: "p1",
    date: "2026-03-12",
    name: "CURSOR USAGE",
    amount: -17.38,
    currency: "EUR",
    supplier: "Cursor",
    account: { name: "KBC-Mastercard", isCard: true },
    booksStatus: null,
    files: [],
    ...overrides,
  };
}

function file(
  overrides: Partial<BooksZipPayment["files"][number]>,
): BooksZipPayment["files"][number] {
  return {
    name: "Invoice-0BB37ACA-0017.pdf",
    path: ["team", "inbox", "Invoice-0BB37ACA-0017.pdf"],
    contentType: "application/pdf",
    invoiceNumber: "0BB37ACA-0017",
    copyGroup: "g1",
    fromBooks: false,
    ...overrides,
  };
}

describe("planBooksZip", () => {
  test("files an invoice under its supplier, named so it finds its payment", () => {
    const plan = planBooksZip([payment({ files: [file({})] })], PERIOD);

    expect(plan.files.map((f) => f.zipPath)).toEqual([
      "Cursor/2026-03-12 - EUR 17,38 - Cursor - invoice 0BB37ACA-0017.pdf",
    ]);
  });

  test("writes a large amount with a thousands separator, and a number without slashes", () => {
    const plan = planBooksZip(
      [
        payment({
          amount: -2406.58,
          supplier: "Federale Overheidsdienst FINANCIEN",
          files: [file({ invoiceNumber: "2223048/99999", name: "a.pdf" })],
        }),
      ],
      PERIOD,
    );

    expect(plan.files[0]?.zipPath).toBe(
      "Federale Overheidsdienst FINANCIEN/2026-03-12 - EUR 2.406,58 - Federale Overheidsdienst FINANCIEN - invoice 2223048-99999.pdf",
    );
  });

  test("labels a receipt and a billing statement as what they are", () => {
    const plan = planBooksZip(
      [
        payment({
          supplier: "Slack",
          files: [
            file({ name: "Receipt-2291-4410.pdf", invoiceNumber: null }),
            file({
              name: "Slack fair billing statement.pdf",
              invoiceNumber: "SBIE-11996809",
            }),
          ],
        }),
      ],
      PERIOD,
    );

    expect(plan.files.map((f) => f.zipPath)).toEqual([
      "Slack/2026-03-12 - EUR 17,38 - Slack - receipt.pdf",
      "Slack/2026-03-12 - EUR 17,38 - Slack - billing statement SBIE-11996809.pdf",
    ]);
  });

  test("keeps the extension of a file that is not a PDF", () => {
    const plan = planBooksZip(
      [
        payment({
          files: [
            file({
              name: "scan.JPG",
              contentType: "image/jpeg",
              invoiceNumber: null,
            }),
          ],
        }),
      ],
      PERIOD,
    );

    expect(plan.files[0]?.zipPath).toEndWith(" - invoice.jpg");
  });

  test("never writes two files to one name", () => {
    const plan = planBooksZip(
      [
        payment({
          files: [
            file({ copyGroup: "a", invoiceNumber: null }),
            file({ copyGroup: "b", invoiceNumber: null }),
          ],
        }),
      ],
      PERIOD,
    );

    expect(plan.files.map((f) => f.zipPath)).toEqual([
      "Cursor/2026-03-12 - EUR 17,38 - Cursor - invoice.pdf",
      "Cursor/2026-03-12 - EUR 17,38 - Cursor - invoice (2).pdf",
    ]);
  });

  test("puts a payment that names nobody in a folder that says so", () => {
    const plan = planBooksZip(
      [payment({ supplier: null, name: "BETALING 123", files: [file({})] })],
      PERIOD,
    );

    expect(plan.files[0]?.zipPath).toBe(
      "No supplier name/2026-03-12 - EUR 17,38 - BETALING 123 - invoice 0BB37ACA-0017.pdf",
    );
  });

  test("files an invoice the books already hold apart, to link rather than upload", () => {
    const plan = planBooksZip(
      [
        payment({
          files: [
            file({ fromBooks: true, name: "Cursor - 0BB37ACA-0017.pdf" }),
          ],
        }),
      ],
      PERIOD,
    );

    expect(plan.files.map((f) => f.zipPath)).toEqual([
      "_Already in the books - link, do not upload/Cursor/2026-03-12 - EUR 17,38 - Cursor - invoice 0BB37ACA-0017.pdf",
    ]);
  });

  test("leaves out the books' copy of an invoice Midday also has from the supplier", () => {
    // The mailed invoice and its Yuki copy, grouped as one document: one file,
    // and the books hold it.
    const plan = planBooksZip(
      [
        payment({
          files: [
            file({ name: "Invoice-0BB37ACA-0017.pdf" }),
            file({ name: "Cursor - 0BB37ACA-0017.pdf", fromBooks: true }),
          ],
        }),
      ],
      PERIOD,
    );

    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({
      alreadyInBooks: true,
      file: { name: "Invoice-0BB37ACA-0017.pdf" },
    });
  });

  test("keeps an invoice and its own receipt, which are two documents", () => {
    const plan = planBooksZip(
      [
        payment({
          files: [
            file({ name: "Invoice-2291-4410.pdf", invoiceNumber: "2291-4410" }),
            file({ name: "Receipt-2291-4410.pdf", invoiceNumber: "2291-4410" }),
          ],
        }),
      ],
      PERIOD,
    );

    expect(plan.files).toHaveLength(2);
  });

  test("lists the payments with no invoice rather than dropping them", () => {
    const plan = planBooksZip(
      [payment({ id: "with", files: [file({})] }), payment({ id: "without" })],
      PERIOD,
    );

    expect(plan.withoutInvoice.map((p) => p.id)).toEqual(["without"]);
  });

  test("leaves out card payments the books settled, only when asked", () => {
    const settled = payment({
      id: "settled",
      booksStatus: "in_the_books",
      files: [file({})],
    });
    const settledAccount = payment({
      id: "account",
      account: { name: "KBC Business", isCard: false },
      booksStatus: "in_the_books",
      files: [file({})],
    });

    expect(planBooksZip([settled], PERIOD).files).toHaveLength(1);

    const plan = planBooksZip([settled, settledAccount], {
      ...PERIOD,
      leaveOutSettledCards: true,
    });
    expect(plan.settledLeftOut.map((p) => p.id)).toEqual(["settled"]);
    // A bank-account payment carries nothing from the books; nothing is left out.
    expect(plan.files.map((f) => f.payment.id)).toEqual(["account"]);
  });
});

describe("booksZipOverview", () => {
  test("is one row per file, semicolon-separated so a Belgian spreadsheet opens it", () => {
    const plan = planBooksZip(
      [
        payment({
          name: 'CURSOR; "USAGE"',
          files: [file({})],
        }),
      ],
      PERIOD,
    );

    expect(booksZipOverview(plan.files).split("\r\n")).toEqual([
      `${BYTE_ORDER_MARK}Supplier;Payment date;Amount;Currency;Card or account;File;Description;Already in the books`,
      'Cursor;2026-03-12;17,38;EUR;KBC-Mastercard;Cursor/2026-03-12 - EUR 17,38 - Cursor - invoice 0BB37ACA-0017.pdf;"CURSOR; ""USAGE""";no',
      "",
    ]);
  });
});

describe("booksZipNotIncluded", () => {
  test("says what is missing, what was left out and why", () => {
    const plan = planBooksZip(
      [
        payment({ id: "missing", supplier: "Slack", name: "SLACK" }),
        payment({
          id: "settled",
          date: "2026-02-01",
          booksStatus: "in_the_books",
        }),
      ],
      { ...PERIOD, leaveOutSettledCards: true },
    );

    const text = booksZipNotIncluded(plan, PERIOD, {
      failed: [],
      duplicates: [],
    });

    expect(text).toContain("Invoices for the books, 2026-01-01 to 2026-06-30");
    expect(text).toContain(
      "Payments with no invoice in Midday (1)\n2026-03-12  EUR 17,38  Slack  (SLACK)",
    );
    expect(text).toContain(
      "Card payments left out because the books have settled them (1)\n2026-02-01  EUR 17,38  Cursor  (CURSOR USAGE)",
    );
  });

  test("names the files that could not be downloaded and the identical copies", () => {
    const plan = planBooksZip(
      [
        payment({
          files: [file({}), file({ copyGroup: "g2", name: "b.pdf" })],
        }),
      ],
      PERIOD,
    );

    const text = booksZipNotIncluded(plan, PERIOD, {
      failed: [plan.files[0]!],
      duplicates: [plan.files[1]!],
    });

    expect(text).toContain(
      "Files that could not be downloaded (1)\nCursor/2026-03-12 - EUR 17,38 - Cursor - invoice 0BB37ACA-0017.pdf",
    );
    expect(text).toContain("Identical copies left out (1)\n");
  });

  test("says so when nothing was left out", () => {
    const plan = planBooksZip([payment({ files: [file({})] })], PERIOD);

    expect(
      booksZipNotIncluded(plan, PERIOD, { failed: [], duplicates: [] }),
    ).toContain("Every payment of the period with an invoice is included.");
  });
});

test("booksZipName says the period", () => {
  expect(booksZipName(PERIOD)).toBe("Invoices 2026-01-01 to 2026-06-30.zip");
});
