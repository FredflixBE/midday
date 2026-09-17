/**
 * What goes into the zip of invoices for the books (FF-1581).
 *
 * Seam under test: the one query the download reads — which payments of a period
 * it offers, the files on each, and what it knows about each file.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/invoices-for-books.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { getInvoicesForBooks } from "../queries/invoice-status";
import { inbox, transactionAttachments, transactions } from "../schema";
import {
  BANK_CREDIT_CARD_ID,
  BANK_USD_CHECKING_ID,
  seedAll,
  TEAM_USD_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const CARD_CHARGE = "d5000000-0000-0000-0000-0000000000a1";
const TRANSFER_PAYMENT = "d5000000-0000-0000-0000-0000000000a2";
const NO_INVOICE_YET = "d5000000-0000-0000-0000-0000000000a3";
const MARKED_DONE = "d5000000-0000-0000-0000-0000000000a4";
const INCOME = "d5000000-0000-0000-0000-0000000000a5";
const OUTSIDE_PERIOD = "d5000000-0000-0000-0000-0000000000a6";

const MAILED = "d5000000-0000-0000-0000-0000000000b1";
const PULLED = "d5000000-0000-0000-0000-0000000000b2";
const XERIUS_MAILED = "d5000000-0000-0000-0000-0000000000b3";
const XERIUS_PULLED_UNATTACHED = "d5000000-0000-0000-0000-0000000000b4";

describe.skipIf(SKIP)("getInvoicesForBooks", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);

    const payment = (
      id: string,
      overrides: Partial<typeof transactions.$inferInsert>,
    ) => ({
      id,
      teamId: TEAM_USD_ID,
      bankAccountId: BANK_USD_CHECKING_ID,
      date: "2031-03-12",
      name: "PAYMENT",
      method: "card_purchase" as const,
      amount: -17.38,
      currency: "EUR",
      internalId: `ff1581-${id}`,
      status: "posted" as const,
      ...overrides,
    });

    await db.insert(transactions).values([
      payment(CARD_CHARGE, {
        bankAccountId: BANK_CREDIT_CARD_ID,
        name: "CURSOR USAGE",
        merchantName: "Cursor",
        booksStatus: "in_the_books",
      }),
      payment(TRANSFER_PAYMENT, {
        date: "2031-03-20",
        name: "Overschrijving Xerius",
        counterpartyName: "Xerius Sociaal Verzekeringsfonds",
        amount: -1214.7,
      }),
      payment(NO_INVOICE_YET, {
        date: "2031-03-25",
        name: "SLACK",
        merchantName: "Slack",
      }),
      payment(MARKED_DONE, { name: "BANK FEE", status: "completed" }),
      payment(INCOME, { name: "CUSTOMER", amount: 500 }),
      payment(OUTSIDE_PERIOD, { date: "2031-04-01", merchantName: "Cursor" }),
    ]);

    const [mailedFile, pulledFile, xeriusFile] = await db
      .insert(transactionAttachments)
      .values([
        {
          teamId: TEAM_USD_ID,
          transactionId: CARD_CHARGE,
          name: "Invoice-0BB37ACA-0017_1a2b3c4d.pdf",
          path: [TEAM_USD_ID, "inbox", "Invoice-0BB37ACA-0017_1a2b3c4d.pdf"],
          type: "application/pdf",
          size: 1000,
        },
        {
          teamId: TEAM_USD_ID,
          transactionId: CARD_CHARGE,
          name: "Cursor - 0BB37ACA-0017.pdf",
          path: [TEAM_USD_ID, "inbox", "Cursor - 0BB37ACA-0017.pdf"],
          type: "application/pdf",
          size: 1200,
        },
        {
          teamId: TEAM_USD_ID,
          transactionId: TRANSFER_PAYMENT,
          name: "scan.jpg",
          path: [TEAM_USD_ID, "transactions", "scan.jpg"],
          type: "image/jpeg",
          size: 900,
        },
      ])
      .returning({ id: transactionAttachments.id });

    await db.insert(inbox).values([
      {
        id: MAILED,
        teamId: TEAM_USD_ID,
        fileName: "Invoice-0BB37ACA-0017_1a2b3c4d.pdf",
        filePath: [TEAM_USD_ID, "inbox", "Invoice-0BB37ACA-0017_1a2b3c4d.pdf"],
        invoiceNumber: "0BB37ACA-0017",
        transactionId: CARD_CHARGE,
        attachmentId: mailedFile!.id,
        status: "done",
      },
      {
        id: PULLED,
        teamId: TEAM_USD_ID,
        fileName: "Cursor - 0BB37ACA-0017.pdf",
        filePath: [TEAM_USD_ID, "inbox", "Cursor - 0BB37ACA-0017.pdf"],
        invoiceNumber: "0BB37ACA-0017",
        referenceId: "yuki:doc-cursor-0017",
        groupedInboxId: MAILED,
        transactionId: CARD_CHARGE,
        attachmentId: pulledFile!.id,
        status: "done",
      },
      {
        id: XERIUS_MAILED,
        teamId: TEAM_USD_ID,
        fileName: "scan.jpg",
        filePath: [TEAM_USD_ID, "transactions", "scan.jpg"],
        invoiceNumber: "900510-281-83",
        transactionId: TRANSFER_PAYMENT,
        attachmentId: xeriusFile!.id,
        status: "done",
      },
      {
        // Pulled back from the books yesterday and matched to no payment, which
        // is what 73 of the live pulled documents look like (FF-1583).
        id: XERIUS_PULLED_UNATTACHED,
        teamId: TEAM_USD_ID,
        fileName: "Xerius - 900510-281-83.pdf",
        filePath: [TEAM_USD_ID, "inbox", "Xerius - 900510-281-83.pdf"],
        invoiceNumber: "900510-281-83",
        referenceId: "yuki:doc-xerius-0001",
        groupedInboxId: XERIUS_MAILED,
        status: "done",
      },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const read = () =>
    getInvoicesForBooks(db, {
      teamId: TEAM_USD_ID,
      from: "2031-03-01",
      to: "2031-03-31",
    });

  test("offers the expenses of the period that still need an invoice or have one", async () => {
    const payments = await read();

    // Not the bank fee marked as needing none, not the income, not April.
    expect(payments.map((p) => p.id).sort()).toEqual(
      [CARD_CHARGE, TRANSFER_PAYMENT, NO_INVOICE_YET].sort(),
    );
  });

  test("tells a card from an account, and carries what the books say", async () => {
    const payments = await read();
    const card = payments.find((p) => p.id === CARD_CHARGE);
    const transfer = payments.find((p) => p.id === TRANSFER_PAYMENT);

    expect(card).toMatchObject({
      account: { name: "Company Credit Card", isCard: true },
      booksStatus: "in_the_books",
      supplier: "Cursor",
    });
    expect(transfer).toMatchObject({
      account: { name: "Business Checking", isCard: false },
      booksStatus: null,
      supplier: "Xerius Sociaal Verzekeringsfonds",
    });
  });

  test("lists each file with the invoice number and copy group of its document", async () => {
    const payments = await read();
    const card = payments.find((p) => p.id === CARD_CHARGE);

    expect(
      card?.files
        .map((f) => ({
          name: f.name,
          invoiceNumber: f.invoiceNumber,
          copyGroup: f.copyGroup,
          fromBooks: f.fromBooks,
          booksHaveIt: f.booksHaveIt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        name: "Cursor - 0BB37ACA-0017.pdf",
        invoiceNumber: "0BB37ACA-0017",
        copyGroup: MAILED,
        fromBooks: true,
        booksHaveIt: true,
      },
      {
        name: "Invoice-0BB37ACA-0017_1a2b3c4d.pdf",
        invoiceNumber: "0BB37ACA-0017",
        copyGroup: MAILED,
        fromBooks: false,
        booksHaveIt: true,
      },
    ]);
  });

  test("says the books hold an invoice whose pulled copy is attached to nothing", async () => {
    // The Xerius invoice: Midday's own scan is on the payment, and the copy
    // pulled from the books sits in the inbox matched to no payment (FF-1583).
    const payments = await read();
    const transfer = payments.find((p) => p.id === TRANSFER_PAYMENT);

    expect(transfer?.files).toEqual([
      {
        name: "scan.jpg",
        path: [TEAM_USD_ID, "transactions", "scan.jpg"],
        contentType: "image/jpeg",
        invoiceNumber: "900510-281-83",
        copyGroup: XERIUS_MAILED,
        fromBooks: false,
        booksHaveIt: true,
      },
    ]);
  });

  test("claims nothing for a payment whose file came from neither the inbox nor the books", async () => {
    await db
      .update(inbox)
      .set({ attachmentId: null, transactionId: null })
      .where(eq(inbox.id, XERIUS_MAILED));

    const payments = await read();

    expect(payments.find((p) => p.id === TRANSFER_PAYMENT)?.files).toEqual([
      {
        name: "scan.jpg",
        path: [TEAM_USD_ID, "transactions", "scan.jpg"],
        contentType: "image/jpeg",
        invoiceNumber: null,
        copyGroup: null,
        fromBooks: false,
        booksHaveIt: false,
      },
    ]);
    expect(payments.find((p) => p.id === NO_INVOICE_YET)?.files).toEqual([]);
  });
});
