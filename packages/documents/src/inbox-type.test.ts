import { describe, expect, test } from "bun:test";
import { inboxTypeFromFileName, resolveInboxType } from "./inbox-type";

describe("inboxTypeFromFileName", () => {
  test("reads the word the supplier put in the file name", () => {
    // Both halves of a real pair, as stored: Anthropic mails the invoice and
    // its receipt as separate attachments carrying one invoice number.
    expect(inboxTypeFromFileName("Invoice-8NCOCMO3-0007_a1b2c3d4.pdf")).toBe(
      "invoice",
    );
    expect(inboxTypeFromFileName("Receipt-2179-6847-3809_e5f6a7b8.pdf")).toBe(
      "expense",
    );
  });

  test("reads it in the languages this inbox actually receives", () => {
    expect(inboxTypeFromFileName("Factuur 2026-0042.pdf")).toBe("invoice");
    expect(inboxTypeFromFileName("facture_avril.pdf")).toBe("invoice");
    expect(inboxTypeFromFileName("kassaticket colruyt.jpg")).toBe("expense");
  });

  test("says nothing when the name says nothing", () => {
    expect(
      inboxTypeFromFileName("Adobe_Transaction_No_3240043752_20251007.pdf"),
    ).toBeNull();
    expect(inboxTypeFromFileName("5474979359_531524d3.pdf")).toBeNull();
    expect(inboxTypeFromFileName("")).toBeNull();
    expect(inboxTypeFromFileName(null)).toBeNull();
  });

  test("says nothing when the name carries both words", () => {
    // Nothing to decide between: a human would open it.
    expect(inboxTypeFromFileName("invoice-and-receipt.pdf")).toBeNull();
  });

  test("is not fooled by a longer word that contains a shorter one", () => {
    // "recurring" would match a naive search for the French "reçu", which is
    // why the short words are left out of the vocabulary entirely.
    expect(inboxTypeFromFileName("recurring-charges-2026.pdf")).toBeNull();
  });
});

describe("resolveInboxType", () => {
  test("calls an extracted receipt an expense", () => {
    expect(
      resolveInboxType({ documentType: "receipt", fallback: "invoice" }),
    ).toBe("expense");
  });

  test("calls an extracted invoice an invoice, whatever the file was", () => {
    // A photographed invoice ran through the receipt processor, whose own
    // guess is "expense". What the document says wins.
    expect(
      resolveInboxType({ documentType: "invoice", fallback: "expense" }),
    ).toBe("invoice");
  });

  test("passes a non-financial document straight through", () => {
    expect(
      resolveInboxType({ documentType: "other", fallback: "invoice" }),
    ).toBe("other");
  });

  test("treats an unusable processor answer as the mimetype's default", () => {
    // `result.type` is typed `string | null` on the way out of the client. The
    // three ingestion paths used to narrow it each for themselves.
    expect(resolveInboxType({ fallback: null })).toBe("invoice");
    expect(resolveInboxType({ fallback: "other" })).toBe("invoice");
  });

  test("keeps the mimetype's guess when nothing else says anything", () => {
    expect(
      resolveInboxType({
        documentType: null,
        fileName: "5474979359.pdf",
        fallback: "invoice",
      }),
    ).toBe("invoice");
    expect(resolveInboxType({ fallback: "expense" })).toBe("expense");
  });

  test("lets the file name correct an extraction that said invoice", () => {
    // "invoice" is what mergeExtractionResults falls back to when neither pass
    // committed, so it is not evidence on its own. A supplier who named the
    // file "Receipt-…" is.
    expect(
      resolveInboxType({
        documentType: "invoice",
        fileName: "Receipt-2179-6847-3809_e5f6a7b8.pdf",
        fallback: "invoice",
      }),
    ).toBe("expense");
  });

  test("lets the file name correct an extraction that said receipt too", () => {
    // Both merge functions fill an absent document_type in — one with
    // "invoice", one with "receipt" — so neither value can be told apart from a
    // blank once it leaves the extractor. A photographed invoice the supplier
    // named `Factuur…` is the case: the receipt processor ran because it is an
    // image, and its merge wrote "receipt" without anything having read that.
    expect(
      resolveInboxType({
        documentType: "receipt",
        fileName: "Factuur 2026-0042.jpg",
        fallback: "expense",
      }),
    ).toBe("invoice");
  });

  test("does not let the file name overrule a non-financial document", () => {
    expect(
      resolveInboxType({
        documentType: "other",
        fileName: "receipt-of-delivery.pdf",
        fallback: "invoice",
      }),
    ).toBe("other");
  });

  test("separates the two halves of a real pair", () => {
    // The 25 pairs that sat in Needs attention: same supplier, same invoice
    // number, both PDFs, and so both "invoice" before this existed.
    const invoice = resolveInboxType({
      documentType: "invoice",
      fileName: "Invoice-29A0586F-92955_cb6601d4.pdf",
      fallback: "invoice",
    });
    const receipt = resolveInboxType({
      documentType: "invoice",
      fileName: "Receipt-2356-5229_bc855958.pdf",
      fallback: "invoice",
    });

    expect(invoice).toBe("invoice");
    expect(receipt).toBe("expense");
    expect(invoice).not.toBe(receipt);
  });
});
