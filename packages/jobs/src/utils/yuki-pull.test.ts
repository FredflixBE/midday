import { describe, expect, test } from "bun:test";
import type { InboxRowForYukiPull } from "@midday/db/queries";
import { yukiInboxReference } from "@midday/db/queries";
import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import type { YukiArchiveDocument } from "@midday/yuki/archive";
import { DEFAULT_YUKI_PULL_CUTOFF } from "../schemas/yuki";
import { planYukiPull } from "./yuki-pull";

function yukiDocument(
  overrides: Partial<YukiArchiveDocument> & { documentId: string },
): YukiArchiveDocument {
  const reference = overrides.reference ?? "INV-1001";

  return {
    folderId: 1,
    type: "2",
    typeDescription: "Aankoopfactuur",
    subject: "Factuur",
    contactName: "Acme",
    contactId: null,
    reference,
    referenceNormalized: comparableInvoiceReference(reference),
    documentDate: "2026-09-01",
    amount: "121.00",
    vatAmount: "21.00",
    contentType: "application/pdf",
    fileSize: "18422",
    createdInYuki: null,
    creator: null,
    modifiedInYuki: null,
    fileName: "Acme BV - INV-1001.pdf",
    ...overrides,
  };
}

function inboxRow(
  overrides: Partial<InboxRowForYukiPull> & { id: string },
): InboxRowForYukiPull {
  return {
    referenceId: null,
    invoiceNumber: null,
    groupedInboxId: null,
    date: null,
    amount: null,
    currency: null,
    status: "done",
    hasMatchSuggestions: false,
    ...overrides,
  };
}

const archiveOf = (...documents: YukiArchiveDocument[]) => ({ documents });

describe("planYukiPull", () => {
  test("pulls a purchase invoice Midday has no row for", () => {
    const plan = planYukiPull({
      archive: archiveOf(yukiDocument({ documentId: "d1" })),
      inboxRows: [],
    });

    expect(plan.pull.map((c) => c.document.documentId)).toEqual(["d1"]);
    expect(plan.counts.purchaseInvoices).toBe(1);
    expect(plan.counts.eligible).toBe(1);
  });

  test("ignores everything that is not a purchase invoice", () => {
    // 106 documents of the measured archive carry a reference without being an
    // invoice, and 9 of those share a number with a real one. A bank statement
    // pulled in as a purchase invoice is the failure this prevents.
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "sale", type: "6" }),
        yukiDocument({ documentId: "statement", type: "10" }),
        yukiDocument({ documentId: "journal", type: "21" }),
        yukiDocument({ documentId: "purchase" }),
      ),
      inboxRows: [],
    });

    expect(plan.pull.map((c) => c.document.documentId)).toEqual(["purchase"]);
    expect(plan.counts.purchaseInvoices).toBe(1);
  });

  test("covers folders the team made, not just Aankoop", () => {
    // One purchase invoice of the measured archive sits in folder 100.
    const plan = planYukiPull({
      archive: archiveOf(yukiDocument({ documentId: "d1", folderId: 100 })),
      inboxRows: [],
    });

    expect(plan.pull).toHaveLength(1);
  });

  test("leaves invoices older than the cutoff in Yuki", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "old", documentDate: "2024-12-31" }),
        yukiDocument({ documentId: "new", documentDate: "2025-01-01" }),
      ),
      inboxRows: [],
      cutoff: DEFAULT_YUKI_PULL_CUTOFF,
    });

    expect(plan.pull.map((c) => c.document.documentId)).toEqual(["new"]);
    expect(plan.counts.beforeCutoff).toBe(1);
  });

  test("takes the cutoff from the caller, so widening it is a re-run", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "old", documentDate: "2023-06-01" }),
      ),
      inboxRows: [],
      cutoff: "2023-01-01",
    });

    expect(plan.pull).toHaveLength(1);
  });

  test("skips a document Yuki gave no date for", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "d1", documentDate: null }),
      ),
      inboxRows: [],
    });

    expect(plan.pull).toHaveLength(0);
    expect(plan.counts.undated).toBe(1);
  });

  test("never pulls a document it already has a row for", () => {
    const plan = planYukiPull({
      archive: archiveOf(yukiDocument({ documentId: "d1" })),
      inboxRows: [
        inboxRow({ id: "row-1", referenceId: yukiInboxReference("d1") }),
      ],
    });

    expect(plan.pull).toHaveLength(0);
    expect(plan.counts.alreadyPulled).toBe(1);
    expect(plan.finish).toEqual([]);
  });

  test("finishes a row an earlier run left half-done", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "d1" }),
        yukiDocument({ documentId: "d2" }),
      ),
      inboxRows: [
        inboxRow({
          id: "row-1",
          referenceId: yukiInboxReference("d1"),
          status: "processing",
        }),
        inboxRow({
          id: "row-2",
          referenceId: yukiInboxReference("d2"),
          status: "pending",
        }),
      ],
    });

    expect(plan.finish).toEqual(["row-1", "row-2"]);
  });

  test("leaves a pending row a person declined the match on alone", () => {
    // `declineSuggestedMatch` puts a row back to pending, which is also where
    // the matcher leaves one it found nothing for. The suggestion behind it is
    // what separates them — without this, every declined match would be
    // re-matched and re-closed the next day.
    const plan = planYukiPull({
      archive: archiveOf(yukiDocument({ documentId: "d1" })),
      inboxRows: [
        inboxRow({
          id: "row-1",
          referenceId: yukiInboxReference("d1"),
          status: "pending",
          hasMatchSuggestions: true,
        }),
      ],
    });

    expect(plan.finish).toEqual([]);
  });

  test("leaves a row with a suggestion waiting for an answer alone", () => {
    const plan = planYukiPull({
      archive: archiveOf(yukiDocument({ documentId: "d1" })),
      inboxRows: [
        inboxRow({
          id: "row-1",
          referenceId: yukiInboxReference("d1"),
          status: "suggested_match",
        }),
      ],
    });

    expect(plan.finish).toEqual([]);
  });

  test("leaves a row a person moved somewhere alone", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "d1" }),
        yukiDocument({ documentId: "d2" }),
      ),
      inboxRows: [
        inboxRow({
          id: "row-1",
          referenceId: yukiInboxReference("d1"),
          status: "archived",
        }),
        inboxRow({
          id: "row-2",
          referenceId: yukiInboxReference("d2"),
          status: "done",
        }),
      ],
    });

    expect(plan.finish).toEqual([]);
  });

  test("groups a Yuki copy onto the row Midday already has for that number", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "d1", reference: "#INV 1001" }),
      ),
      inboxRows: [inboxRow({ id: "row-1", invoiceNumber: "inv-1001" })],
    });

    // Normalised on both sides by the one function FF-1493 uses, so punctuation
    // and case are not two invoices.
    expect(plan.pull[0]?.groupWith).toBe("row-1");
    expect(plan.counts.duplicates).toBe(1);
  });

  test("points at the group's primary, not at one of its siblings", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "d1", reference: "INV-7" }),
      ),
      inboxRows: [
        inboxRow({
          id: "sibling",
          invoiceNumber: "INV-7",
          groupedInboxId: "primary",
        }),
        inboxRow({ id: "primary", invoiceNumber: "INV-7" }),
      ],
    });

    expect(plan.pull[0]?.groupWith).toBe("primary");
  });

  test("groups onto the first row carrying the number, not an arbitrary one", () => {
    // Two ungrouped rows carrying one number: the first wins. The query that
    // feeds this orders by creation, so the row that wins is the oldest, and
    // two runs over unchanged data plan the same thing.
    const rows = [
      inboxRow({ id: "first", invoiceNumber: "INV-9" }),
      inboxRow({ id: "second", invoiceNumber: "INV-9" }),
    ];
    const archive = archiveOf(
      yukiDocument({ documentId: "d1", reference: "INV-9" }),
    );

    expect(planYukiPull({ archive, inboxRows: rows }).pull[0]?.groupWith).toBe(
      "first",
    );
    expect(
      planYukiPull({ archive, inboxRows: [...rows].reverse() }).pull[0]
        ?.groupWith,
    ).toBe("second");
  });

  test("does not group on a number too short to mean anything", () => {
    // Rule 1's floor: below four comparable characters a match is as likely to
    // be someone else's number as the right one.
    const plan = planYukiPull({
      archive: archiveOf(yukiDocument({ documentId: "d1", reference: "7/2" })),
      inboxRows: [inboxRow({ id: "row-1", invoiceNumber: "7/2" })],
    });

    expect(plan.pull[0]?.groupWith).toBeNull();
    expect(plan.counts.duplicates).toBe(0);
  });

  test("still pulls a document with no usable number, ungrouped", () => {
    // "If either side has no usable number, don't merge" — and never on
    // supplier plus amount plus date, which is the comparison the epic forbids.
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({
          documentId: "d1",
          reference: null,
          referenceNormalized: null,
        }),
      ),
      inboxRows: [inboxRow({ id: "row-1", invoiceNumber: "INV-1001" })],
    });

    expect(plan.pull).toHaveLength(1);
    expect(plan.pull[0]?.groupWith).toBeNull();
  });

  describe("a reference a supplier reuses across invoices (FF-1574)", () => {
    // The real shapes from the live books. Each supplier puts a number in
    // Yuki's reference that is not an invoice number, so different invoices
    // share it — and a group is matched as one unit, so a wrong one drags an
    // unrelated invoice onto a payment.

    test("does not file a new KBC notice as a copy of an older one", () => {
      // Policy number C20601746442 on monthly notices.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "jun-2026",
            reference: "C20601746442",
            documentDate: "2026-06-10",
            amount: "202.98",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "jan-2025",
            invoiceNumber: "c20601746442",
            date: "2025-01-10",
            amount: 191.03,
            currency: "EUR",
          }),
          inboxRow({
            id: "nov-2025",
            invoiceNumber: "C20601746442",
            date: "2025-11-10",
            amount: 196.79,
            currency: "EUR",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBeNull();
      expect(plan.counts.duplicates).toBe(0);
    });

    test("does not group KBC's yearly bills on their structured reference", () => {
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "2026",
            reference: "153/7933/96229",
            documentDate: "2026-01-15",
            amount: "28.83",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "2025",
            invoiceNumber: "153/7933/96229",
            date: "2025-02-27",
            amount: 43.39,
            currency: "EUR",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBeNull();
    });

    test("does not group Xerius invoices on the member number", () => {
      // The recurrence of 2026-09-17: the April invoice was filed as a copy of
      // the July one.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "apr",
            reference: "900510.281.83",
            documentDate: "2026-04-22",
            amount: "1260.18",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "jan",
            invoiceNumber: "900510.281.83",
            date: "2026-01-28",
            amount: 2406.58,
            currency: "EUR",
          }),
          inboxRow({
            id: "jul",
            invoiceNumber: "900510.281.83",
            date: "2026-07-29",
            amount: 1214.7,
            currency: "EUR",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBeNull();
    });

    test("does not group two new documents of one run on a reference Yuki reuses", () => {
      // Nothing in the inbox yet to disagree with, but the archive itself
      // carries the reference on invoices of different dates: it is not an
      // invoice number, whatever the totals of one pair say.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "jan",
            reference: "900510.281.83",
            documentDate: "2026-01-28",
            amount: "1214.70",
          }),
          yukiDocument({
            documentId: "jul",
            reference: "900510.281.83",
            documentDate: "2026-07-29",
            amount: "1214.70",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "mail",
            invoiceNumber: "900510.281.83",
            amount: 1214.7,
            currency: "EUR",
          }),
        ],
      });

      expect(plan.pull.map((c) => c.groupWith)).toEqual([null, null]);
    });

    test("does not group on a number two separate inbox rows carry with different dates", () => {
      // No totals to compare: the two rows alone show the number recurs.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "d1",
            reference: "C20601746442",
            amount: null,
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "jan",
            invoiceNumber: "C20601746442",
            date: "2025-01-10",
          }),
          inboxRow({
            id: "nov",
            invoiceNumber: "C20601746442",
            date: "2025-11-10",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBeNull();
    });

    test("counts a group once, so a copy already grouped does not make its number look reused", () => {
      // Four Eyes again, after the first pull grouped the Yuki copy onto the
      // mail row: a later document carrying the number still hangs off it.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "another-copy",
            reference: "202501499",
            documentDate: "2025-10-31",
            amount: "1330.40",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "mail",
            invoiceNumber: "202501499",
            date: "2025-11-30",
            amount: 1330.4,
            currency: "EUR",
          }),
          inboxRow({
            id: "yuki",
            invoiceNumber: "202501499",
            date: "2025-10-31",
            amount: 1330.4,
            currency: "EUR",
            groupedInboxId: "mail",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBe("mail");
    });

    test("does not group when the totals disagree, even on a reference seen once", () => {
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "d1",
            reference: "INV-2026-0042",
            amount: "121.00",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "row-1",
            invoiceNumber: "INV-2026-0042",
            amount: 99.5,
            currency: "EUR",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBeNull();
    });

    test("still groups a genuine copy that arrived by mail, dated a month apart", () => {
      // Four Eyes invoice 202501499: the mail copy carries 2025-11-30, Yuki's
      // record 2025-10-31, and both bill EUR 1,330.40. A date is not a reason
      // to refuse — an extractor reads a due date as readily as an issue date.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "four-eyes",
            reference: "202501499",
            documentDate: "2025-10-31",
            amount: "1330.40",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "mail",
            invoiceNumber: "202501499",
            date: "2025-11-30",
            amount: 1330.4,
            currency: "EUR",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBe("mail");
    });

    test("does not let a total in another currency refuse a copy", () => {
      // Yuki's archive total is the euro it booked; a row that bills dollars
      // (FF-1572) says nothing about whether that is the same invoice.
      const plan = planYukiPull({
        archive: archiveOf(
          yukiDocument({
            documentId: "d1",
            reference: "INV-2026-0042",
            amount: "18.37",
          }),
        ),
        inboxRows: [
          inboxRow({
            id: "row-1",
            invoiceNumber: "INV-2026-0042",
            amount: 19.95,
            currency: "USD",
          }),
        ],
      });

      expect(plan.pull[0]?.groupWith).toBe("row-1");
    });
  });

  test("bounds a run and reports what it left behind, newest first", () => {
    const plan = planYukiPull({
      archive: archiveOf(
        yukiDocument({ documentId: "oldest", documentDate: "2026-01-01" }),
        yukiDocument({ documentId: "newest", documentDate: "2026-03-01" }),
        yukiDocument({ documentId: "middle", documentDate: "2026-02-01" }),
      ),
      inboxRows: [],
      limit: 2,
    });

    expect(plan.pull.map((c) => c.document.documentId)).toEqual([
      "newest",
      "middle",
    ]);
    expect(plan.counts.eligible).toBe(3);
    expect(plan.counts.remaining).toBe(1);
  });
});
