import { describe, expect, it } from "bun:test";
import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import type { YukiArchiveDocument } from "./archive";
import { buildYukiArchive } from "./archive";
import {
  decideYukiDelivery,
  MINIMUM_COMPARABLE_REFERENCE_LENGTH,
  requiresDocumentText,
  type YukiDeliveryCandidate,
} from "./decide";

function yukiDocument(
  overrides: Partial<YukiArchiveDocument> & { reference: string },
): YukiArchiveDocument {
  return {
    documentId: `yuki-${overrides.reference}`,
    folderId: 1,
    type: "2",
    typeDescription: "Aankoopfactuur",
    subject: null,
    contactName: null,
    contactId: null,
    referenceNormalized: comparableInvoiceReference(overrides.reference),
    documentDate: null,
    amount: null,
    vatAmount: null,
    contentType: "application/pdf",
    fileSize: null,
    createdInYuki: null,
    creator: null,
    modifiedInYuki: null,
    fileName: null,
    ...overrides,
  };
}

/** A real archive, built the same way production builds it. */
function archiveOf(...documents: YukiArchiveDocument[]) {
  return buildYukiArchive({ folders: [], documents, calls: 0 });
}

/**
 * A document that passes every rule, so each test only has to state the one
 * thing it is about.
 *
 * The text layer defaults to one that really contains the number, derived from
 * whatever number the test set — otherwise a test about rule 3 would quietly be
 * a test about rule 1.
 */
function candidate(
  overrides: Partial<YukiDeliveryCandidate> & { id: string },
): YukiDeliveryCandidate {
  const invoiceNumber =
    "invoiceNumber" in overrides ? overrides.invoiceNumber : "INV-2026-0042";
  return {
    type: "invoice",
    documentText: `Invoice ${invoiceNumber ?? ""} — total due 120,00 EUR`,
    ...overrides,
    invoiceNumber: invoiceNumber ?? null,
  };
}

function decide(
  documents: YukiDeliveryCandidate[],
  archive = archiveOf(),
  options: { now?: Date; bookingGraceDays?: number } = {},
) {
  return decideYukiDelivery({ documents, archive, ...options });
}

function only(
  documents: YukiDeliveryCandidate[],
  archive = archiveOf(),
  options: { now?: Date; bookingGraceDays?: number } = {},
) {
  const [decision] = decide(documents, archive, options);
  if (!decision) throw new Error("expected a decision");
  return decision;
}

describe("scope", () => {
  it("a document Midday filed as not financial is never sent", () => {
    expect(only([candidate({ id: "a", type: "other" })])).toMatchObject({
      action: "not_applicable",
      reason: "not_an_invoice",
    });
  });

  it("a document still being extracted has no number to decide on", () => {
    expect(only([candidate({ id: "a", type: null })])).toMatchObject({
      action: "not_applicable",
      reason: "not_extracted",
    });
  });

  it("a receipt is a purchase document too, and is sent", () => {
    expect(only([candidate({ id: "a", type: "expense" })])).toMatchObject({
      action: "send",
    });
  });

  it("an out-of-scope document does not make an in-scope one ambiguous", () => {
    // Rule 2 would otherwise fire on a receipt Midday filed as `other` that
    // happens to carry the same number, and hold up a real invoice.
    const decisions = decide([
      candidate({ id: "invoice" }),
      candidate({ id: "junk", type: "other" }),
    ]);

    expect(decisions[0]).toMatchObject({ id: "invoice", action: "send" });
  });
});

describe("a document that charges nothing", () => {
  it("has no payment to be booked against, so there is nothing to deliver", () => {
    expect(only([candidate({ id: "a", zeroTotal: true })])).toMatchObject({
      action: "not_applicable",
      reason: "no_payment_expected",
    });
  });

  it("is settled before rule 1, so a missing text layer is not the answer given", () => {
    // "No text layer" about a free-tier invoice is true and useless. The
    // reason a person needs is that nothing was ever charged.
    expect(
      only([candidate({ id: "a", zeroTotal: true, documentText: null })]),
    ).toMatchObject({ reason: "no_payment_expected" });
  });

  it("is not a rival claim on its invoice number", () => {
    // Google issues a 0.00 invoice and a charged one in the same month. The
    // charged one must still go.
    const decisions = decide([
      candidate({ id: "charged", invoiceNumber: "GC-2026-1" }),
      candidate({
        id: "free-tier",
        invoiceNumber: "GC-2026-1",
        zeroTotal: true,
      }),
    ]);

    expect(decisions[0]).toMatchObject({ id: "charged", action: "send" });
    expect(decisions[1]).toMatchObject({
      id: "free-tier",
      action: "not_applicable",
    });
  });

  it("does not change what a charged document decides", () => {
    // Only zero is tested. An amount is never otherwise in play, so a document
    // that charges something decides exactly as it did before.
    expect(only([candidate({ id: "a", zeroTotal: false })])).toEqual(
      only([candidate({ id: "a" })]),
    );
  });
});

describe("rule 1 — the number has to be in the document", () => {
  it("no number extracted at all", () => {
    expect(only([candidate({ id: "a", invoiceNumber: null })])).toMatchObject({
      action: "needs_attention",
      reason: "no_invoice_number",
    });
  });

  it("a blank number is the same as none", () => {
    expect(only([candidate({ id: "a", invoiceNumber: "   " })])).toMatchObject({
      action: "needs_attention",
      reason: "no_invoice_number",
    });
  });

  it("a number with nothing comparable in it is refused, not looked up", () => {
    expect(
      only([candidate({ id: "a", invoiceNumber: "--/--" })]),
    ).toMatchObject({
      action: "needs_attention",
      reason: "invoice_number_unusable",
    });
  });

  it("a number shorter than the shortest real one is refused", () => {
    const short = "A".repeat(MINIMUM_COMPARABLE_REFERENCE_LENGTH - 1);
    expect(
      only([
        candidate({
          id: "a",
          invoiceNumber: short,
          documentText: `Invoice ${short}`,
        }),
      ]),
    ).toMatchObject({
      action: "needs_attention",
      reason: "invoice_number_too_short",
    });
  });

  it("a number exactly at the floor is usable", () => {
    const shortest = "A".repeat(MINIMUM_COMPARABLE_REFERENCE_LENGTH);
    expect(
      only([
        candidate({
          id: "a",
          invoiceNumber: shortest,
          documentText: `Invoice ${shortest}`,
        }),
      ]),
    ).toMatchObject({ action: "send" });
  });

  it("a scan has no text layer, so the number cannot be verified", () => {
    expect(only([candidate({ id: "a", documentText: null })])).toMatchObject({
      action: "needs_attention",
      reason: "no_text_layer",
    });
  });

  it("an empty text layer is the same as none", () => {
    expect(only([candidate({ id: "a", documentText: "  \n " })])).toMatchObject(
      {
        action: "needs_attention",
        reason: "no_text_layer",
      },
    );
  });

  it("a number the document does not contain is refused", () => {
    expect(
      only([
        candidate({
          id: "a",
          invoiceNumber: "INV-2026-0042",
          documentText: "Invoice INV-2026-9999 — total due 120,00 EUR",
        }),
      ]),
    ).toMatchObject({
      action: "needs_attention",
      reason: "invoice_number_not_in_document",
    });
  });

  it("spacing and punctuation do not stop the number being found", () => {
    // 5 of the 13 measured documents differed from the extracted number only
    // this way.
    expect(
      only([
        candidate({
          id: "a",
          invoiceNumber: "INV-2026-0042",
          documentText: "Factuurnummer: INV 2026 0042",
        }),
      ]),
    ).toMatchObject({ action: "send" });
  });

  it("a Peppol document needs no text layer, because the number is a field", () => {
    expect(
      only([candidate({ id: "a", documentText: null, structured: true })]),
    ).toMatchObject({ action: "send" });
  });

  it("a Peppol document is still refused an unusable number", () => {
    expect(
      only([
        candidate({
          id: "a",
          invoiceNumber: "///",
          documentText: null,
          structured: true,
        }),
      ]),
    ).toMatchObject({
      action: "needs_attention",
      reason: "invoice_number_unusable",
    });
  });
});

describe("rule 2 — two Midday documents, one number", () => {
  it("both of them need a human, and neither is sent", () => {
    const decisions = decide([
      candidate({ id: "invoice", invoiceNumber: "SLACK-77" }),
      candidate({ id: "statement", invoiceNumber: "slack 77" }),
    ]);

    expect(decisions).toMatchObject([
      {
        id: "invoice",
        action: "needs_attention",
        reason: "shared_invoice_number",
        sharedWith: ["statement"],
      },
      {
        id: "statement",
        action: "needs_attention",
        reason: "shared_invoice_number",
        sharedWith: ["invoice"],
      },
    ]);
  });

  it("a document whose number is not in its own text is not a rival claim", () => {
    // The extractor misread one document and gave it another's number. That is
    // not two documents carrying one number, it is one document and one
    // misreading — so the real invoice goes out rather than waiting on a human.
    const decisions = decide([
      candidate({ id: "good", invoiceNumber: "SHARED-1" }),
      candidate({
        id: "misread",
        invoiceNumber: "SHARED-1",
        documentText: "a totally different document",
      }),
    ]);

    expect(decisions[0]).toMatchObject({ id: "good", action: "send" });
    expect(decisions[1]).toMatchObject({
      id: "misread",
      action: "needs_attention",
      reason: "invoice_number_not_in_document",
    });
  });

  it("still asks, even when Yuki holds that number already", () => {
    // Yuki holds the invoice, not the statement. Answering "in Yuki" for both
    // would attach one Yuki document to two Midday rows and claim Yuki holds a
    // statement it has never seen — so rule 2 runs ahead of the archive.
    const decisions = decide(
      [
        candidate({ id: "invoice", invoiceNumber: "SLACK-77" }),
        candidate({ id: "statement", invoiceNumber: "slack 77" }),
      ],
      archiveOf(yukiDocument({ reference: "SLACK-77" })),
    );

    expect(decisions.map((d) => d.reason)).toEqual([
      "shared_invoice_number",
      "shared_invoice_number",
    ]);
  });
});

describe("rule 3 — Yuki already holds it", () => {
  it("a purchase invoice with that number stops the delivery", () => {
    const decision = only(
      [candidate({ id: "a", invoiceNumber: "INV-2026-0042" })],
      archiveOf(yukiDocument({ reference: "inv 2026 0042" })),
    );

    expect(decision).toMatchObject({ action: "in_yuki" });
    expect(decision.yukiDocuments.map((d) => d.documentId)).toEqual([
      "yuki-inv 2026 0042",
    ]);
  });

  it("Midday's own sales invoice is never delivered back in as a purchase", () => {
    expect(
      only(
        [candidate({ id: "a", invoiceNumber: "F2026-001" })],
        archiveOf(
          yukiDocument({
            reference: "F2026-001",
            type: "6",
            typeDescription: "Verkoopfactuur",
          }),
        ),
      ),
    ).toMatchObject({ action: "in_yuki" });
  });

  it("every document carrying the number is reported, not just the first", () => {
    const decision = only(
      [candidate({ id: "a", invoiceNumber: "REPEAT-9" })],
      archiveOf(
        yukiDocument({ reference: "REPEAT-9", documentId: "first" }),
        yukiDocument({ reference: "repeat 9", documentId: "second" }),
      ),
    );

    expect(decision.yukiDocuments.map((d) => d.documentId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("a bank statement reusing the number does not count as the invoice", () => {
    // 9 references in the measured archive collided this way.
    expect(
      only(
        [candidate({ id: "a", invoiceNumber: "INV-2026-0042" })],
        archiveOf(
          yukiDocument({
            reference: "INV-2026-0042",
            type: "10",
            typeDescription: "Rekeninguittreksel",
          }),
        ),
      ),
    ).not.toMatchObject({ action: "in_yuki" });
  });
});

describe("rule 3½ — Yuki has the number, but not yet on an invoice", () => {
  it("it needs a human rather than a second delivery", () => {
    const decision = only(
      [candidate({ id: "a", invoiceNumber: "INV-2026-0042" })],
      archiveOf(
        yukiDocument({
          reference: "INV-2026-0042",
          type: "0",
          typeDescription: "Standaard",
        }),
      ),
    );

    expect(decision).toMatchObject({
      action: "needs_attention",
      reason: "in_yuki_unclassified",
    });
    expect(decision.yukiDocuments).toHaveLength(1);
  });

  it("an invoice outranks an unclassified document with the same number", () => {
    expect(
      only(
        [candidate({ id: "a", invoiceNumber: "INV-2026-0042" })],
        archiveOf(
          yukiDocument({ reference: "INV-2026-0042", type: "0" }),
          yukiDocument({
            reference: "INV-2026-0042",
            type: "2",
            documentId: "booked",
          }),
        ),
      ),
    ).toMatchObject({ action: "in_yuki" });
  });
});

describe("rule 4 — send", () => {
  it("a verified number nothing in Yuki carries", () => {
    expect(
      only(
        [candidate({ id: "a" })],
        archiveOf(yukiDocument({ reference: "SOMETHING-ELSE" })),
      ),
    ).toMatchObject({ action: "send", comparableReference: "INV20260042" });
  });
});

describe("rule 5 — did it land?", () => {
  const now = new Date("2026-09-20T12:00:00Z");

  it("a delivered document Yuki has booked is settled", () => {
    expect(
      only(
        [candidate({ id: "a", deliveredOn: "2026-09-19" })],
        archiveOf(yukiDocument({ reference: "INV-2026-0042" })),
        { now },
      ),
    ).toMatchObject({ action: "in_yuki" });
  });

  it("inside the grace window there is simply nothing to do", () => {
    expect(
      only([candidate({ id: "a", deliveredOn: "2026-09-19" })], archiveOf(), {
        now,
      }),
    ).toMatchObject({ action: "not_applicable", reason: "awaiting_yuki" });
  });

  it("past the grace window it needs a human", () => {
    expect(
      only([candidate({ id: "a", deliveredOn: "2026-09-01" })], archiveOf(), {
        now,
      }),
    ).toMatchObject({
      action: "needs_attention",
      reason: "not_booked_after_delivery",
    });
  });

  it("a delivered document is never sent again, whatever rule 1 now says", () => {
    // The text layer failing to extract on a later run must not be able to
    // turn a delivered document back into a delivery.
    for (const broken of [
      { documentText: null },
      { invoiceNumber: null },
      { invoiceNumber: "--" },
    ]) {
      const decision = only(
        [candidate({ id: "a", deliveredOn: "2026-09-19", ...broken })],
        archiveOf(),
        { now },
      );
      expect(decision.action).not.toBe("send");
    }
  });

  it("a delivered document does not hold up its own duplicate check", () => {
    // Rule 2 runs over the set, and a delivered document is still part of it.
    const decisions = decide(
      [
        candidate({ id: "delivered", deliveredOn: "2026-09-19" }),
        candidate({ id: "other" }),
      ],
      archiveOf(),
      { now },
    );

    expect(decisions[0]).toMatchObject({ action: "not_applicable" });
    expect(decisions[1]).toMatchObject({
      action: "needs_attention",
      reason: "shared_invoice_number",
    });
  });
});

describe("the set as a whole", () => {
  it("one decision per document, in the order given", () => {
    const decisions = decide([
      candidate({ id: "a", invoiceNumber: "AAAA-1" }),
      candidate({ id: "b", invoiceNumber: "BBBB-2", documentText: "BBBB-2" }),
      candidate({ id: "c", type: "other" }),
    ]);

    expect(decisions.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("an empty set decides nothing", () => {
    expect(decide([])).toEqual([]);
  });
});

describe("requiresDocumentText", () => {
  it("yes for a document that will reach rule 1's check", () => {
    expect(requiresDocumentText(candidate({ id: "a" }))).toBe(true);
  });

  it("no for one that cannot reach it", () => {
    const skipped = [
      candidate({ id: "a", type: "other" }),
      candidate({ id: "a", type: null }),
      candidate({ id: "a", structured: true }),
      candidate({ id: "a", deliveredOn: "2026-09-01" }),
      candidate({ id: "a", invoiceNumber: null }),
      candidate({ id: "a", invoiceNumber: "///" }),
      candidate({ id: "a", invoiceNumber: "AB" }),
      candidate({ id: "a", zeroTotal: true }),
    ];

    for (const document of skipped) {
      expect(requiresDocumentText(document)).toBe(false);
    }
  });

  it("skipping the download does not change the decision", () => {
    // The optimisation has to be invisible: a document it says no about must
    // decide the same way whether or not its text was fetched.
    for (const document of [
      candidate({ id: "a", type: "other" }),
      candidate({ id: "a", structured: true }),
      candidate({ id: "a", invoiceNumber: "AB" }),
    ]) {
      expect(only([{ ...document, documentText: null }])).toEqual(
        only([document]),
      );
    }
  });
});
