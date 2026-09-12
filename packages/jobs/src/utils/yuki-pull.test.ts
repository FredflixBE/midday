import { describe, expect, test } from "bun:test";
import type { InboxRowForYukiPull } from "@midday/db/queries";
import { yukiInboxReference } from "@midday/db/queries";
import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import type { YukiArchiveDocument } from "@midday/yuki/archive";
import { DEFAULT_YUKI_PULL_CUTOFF, planYukiPull } from "./yuki-pull";

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
    status: "done",
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
