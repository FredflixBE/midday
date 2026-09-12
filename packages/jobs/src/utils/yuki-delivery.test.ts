import { describe, expect, test } from "bun:test";
import type { InboxDocumentForYukiDelivery } from "@midday/db/queries";
import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import type { YukiArchiveDocument } from "@midday/yuki/archive";
import { buildYukiArchive } from "@midday/yuki/archive";
import { summariseYukiDelivery } from "./yuki-delivery";

function inboxDocument(
  overrides: Partial<InboxDocumentForYukiDelivery> & { id: string },
): InboxDocumentForYukiDelivery {
  return {
    filePath: ["team", `${overrides.id}.pdf`],
    contentType: "application/pdf",
    invoiceNumber: "INV-2026-0042",
    type: "invoice",
    displayName: "Some Supplier",
    date: "2026-09-01",
    amount: 120,
    currency: "EUR",
    website: null,
    matchedTransactionId: null,
    ...overrides,
  };
}

function yukiInvoice(reference: string): YukiArchiveDocument {
  return {
    documentId: `yuki-${reference}`,
    folderId: 1,
    type: "2",
    typeDescription: "Aankoopfactuur",
    contactName: null,
    contactId: null,
    reference,
    referenceNormalized: comparableInvoiceReference(reference),
    documentDate: null,
    amount: null,
    createdInYuki: null,
    creator: null,
    modifiedInYuki: null,
    fileName: null,
  };
}

const emptyArchive = buildYukiArchive({
  folders: [],
  documents: [],
  calls: 15,
});

/** A text layer that always contains whatever number was extracted. */
const readMatchingText = async (document: InboxDocumentForYukiDelivery) =>
  `Factuur ${document.invoiceNumber ?? ""} bedrag 120,00`;

describe("summariseYukiDelivery", () => {
  test("counts all four actions, including the zeroes", async () => {
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [inboxDocument({ id: "a" })],
      archive: emptyArchive,
      readDocumentText: readMatchingText,
    });

    expect(report.counts).toEqual({
      send: 1,
      in_yuki: 0,
      needs_attention: 0,
      not_applicable: 0,
    });
  });

  test("reports the reason codes a human would work from", async () => {
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({ id: "sendable", invoiceNumber: "AAAA-1" }),
        inboxDocument({ id: "booked", invoiceNumber: "BBBB-2" }),
        inboxDocument({ id: "numberless", invoiceNumber: null }),
        inboxDocument({ id: "junk", type: "other" }),
      ],
      archive: buildYukiArchive({
        folders: [],
        documents: [yukiInvoice("BBBB-2")],
        calls: 15,
      }),
      readDocumentText: readMatchingText,
    });

    expect(report.counts).toEqual({
      send: 1,
      in_yuki: 1,
      needs_attention: 1,
      not_applicable: 1,
    });
    expect(report.reasons).toEqual({
      no_invoice_number: 1,
      not_an_invoice: 1,
    });
  });

  test("only fetches the text layers that can change an answer", async () => {
    const asked: string[] = [];

    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({ id: "needs-it", invoiceNumber: "AAAA-1" }),
        // Out of scope, so nothing about its text could matter.
        inboxDocument({ id: "junk", type: "other" }),
        // No number to look for in the first place.
        inboxDocument({ id: "numberless", invoiceNumber: null }),
      ],
      archive: emptyArchive,
      readDocumentText: async (document) => {
        asked.push(document.id);
        return readMatchingText(document);
      },
    });

    expect(asked).toEqual(["needs-it"]);
    expect(report.textLayersRead).toEqual({ fetched: 1, ofDocuments: 3 });
  });

  test("a document whose text cannot be read needs a human, and the rest go on", async () => {
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({ id: "scan", invoiceNumber: "AAAA-1" }),
        inboxDocument({ id: "readable", invoiceNumber: "BBBB-2" }),
      ],
      archive: emptyArchive,
      readDocumentText: async (document) =>
        document.id === "scan" ? null : readMatchingText(document),
    });

    expect(report.counts).toMatchObject({ send: 1, needs_attention: 1 });
    expect(report.reasons).toEqual({ no_text_layer: 1 });
  });

  test("passes the archive's own measurements through for the run log", async () => {
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [],
      archive: buildYukiArchive({
        folders: [{ id: 1, description: "Aankoop", processedByYuki: true }],
        documents: [yukiInvoice("AAAA-1")],
        calls: 15,
      }),
      readDocumentText: readMatchingText,
    });

    expect(report.archive).toMatchObject({
      documents: 1,
      folders: 1,
      calls: 15,
    });
    expect(report.decisions).toEqual([]);
  });

  test("reports whether a document Midday would send is a purchase it can see", async () => {
    // Not a rule — a signal. It becomes the gate once FF-1517 links the
    // Mastercard and the match rate stops being 4%.
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({
          id: "paid",
          invoiceNumber: "AAAA-1",
          matchedTransactionId: "tx-1",
        }),
        inboxDocument({ id: "unexplained", invoiceNumber: "BBBB-2" }),
        inboxDocument({ id: "also-unexplained", invoiceNumber: "CCCC-3" }),
      ],
      archive: emptyArchive,
      readDocumentText: readMatchingText,
    });

    expect(report.counts.send).toBe(3);
    expect(report.sendWithoutTransaction).toBe(2);
    expect(report.decisions.map((d) => [d.id, d.matchedTransactionId])).toEqual(
      [
        ["paid", "tx-1"],
        ["unexplained", null],
        ["also-unexplained", null],
      ],
    );
  });

  test("the signal does not count documents that were never going to be sent", async () => {
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [inboxDocument({ id: "junk", type: "other" })],
      archive: emptyArchive,
      readDocumentText: readMatchingText,
    });

    expect(report.counts.send).toBe(0);
    expect(report.sendWithoutTransaction).toBe(0);
  });

  test("a zero-amount document is reported as having no payment to expect", async () => {
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({ id: "free-tier", invoiceNumber: "AAAA-1", amount: 0 }),
        inboxDocument({ id: "charged", invoiceNumber: "BBBB-2", amount: 120 }),
      ],
      archive: emptyArchive,
      readDocumentText: readMatchingText,
    });

    expect(report.counts).toMatchObject({ send: 1, not_applicable: 1 });
    expect(report.reasons).toEqual({ no_payment_expected: 1 });
  });

  test("a zero-amount document costs no text-layer download", async () => {
    const asked: string[] = [];
    await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({ id: "free-tier", invoiceNumber: "AAAA-1", amount: 0 }),
        inboxDocument({ id: "charged", invoiceNumber: "BBBB-2", amount: 120 }),
      ],
      archive: emptyArchive,
      readDocumentText: async (d) => {
        asked.push(d.id);
        return readMatchingText(d);
      },
    });

    expect(asked).toEqual(["charged"]);
  });

  test("a null amount is not a zero amount", async () => {
    // Extraction finding nothing is a different state from a document that
    // says zero, and 30 rows in the live inbox are in it. It must not be
    // silently filed as "no payment expected".
    const report = await summariseYukiDelivery({
      teamId: "team-1",
      documents: [
        inboxDocument({ id: "unknown", invoiceNumber: "AAAA-1", amount: null }),
      ],
      archive: emptyArchive,
      readDocumentText: readMatchingText,
    });

    expect(report.counts.not_applicable).toBe(0);
    expect(report.counts.send).toBe(1);
  });
});
