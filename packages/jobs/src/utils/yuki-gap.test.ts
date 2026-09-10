import { describe, expect, it } from "bun:test";
import type { YukiOutstandingItem } from "@midday/yuki";
import { type InboxDocument, reconcileYukiGap } from "./yuki-gap";

// Every amount, date and id below is invented — this repository is public.

function payment(
  overrides: Partial<YukiOutstandingItem> = {},
): YukiOutstandingItem {
  return {
    kind: "payment_awaiting_invoice",
    typeLabel: "Creditcardbetaling",
    documentId: "pay-1",
    date: "2026-03-14",
    contact: "OpenAI",
    contactId: "contact-openai",
    description:
      "MASTERCARD - Kaartverrichtingen - OPENAI  CHATGPT SUBSCR  SAN FRAN",
    openAmount: -21.4,
    ...overrides,
  };
}

function document(overrides: Partial<InboxDocument> = {}): InboxDocument {
  return {
    id: "inbox-1",
    displayName: "OpenAI",
    amount: 21.4,
    currency: "EUR",
    baseAmount: 21.4,
    baseCurrency: "EUR",
    date: "2026-03-13",
    invoiceNumber: "INV-OPENAI-0001",
    website: "openai.com",
    type: "invoice",
    ...overrides,
  };
}

describe("reconcileYukiGap", () => {
  it("pushes the one document that clearly belongs to a payment Yuki is missing an invoice for", () => {
    const report = reconcileYukiGap({
      items: [payment()],
      documents: [document()],
      bookCurrency: "EUR",
    });

    expect(
      report.push.map((p) => [p.payment.documentId, p.document.id]),
    ).toEqual([["pay-1", "inbox-1"]]);
    expect(report.review).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("reports a payment Midday has no document for as missing on both sides", () => {
    const report = reconcileYukiGap({
      items: [payment()],
      documents: [],
      bookCurrency: "EUR",
    });

    expect(report.missing.map((m) => m.payment.documentId)).toEqual(["pay-1"]);
    expect(report.push).toEqual([]);
    expect(report.review).toEqual([]);
  });

  it("refuses to choose between two documents that both plausibly belong to the payment", () => {
    // A duplicate import, or two near-identical receipts: either could be the
    // right one, and an upload cannot be taken back. A person decides.
    const report = reconcileYukiGap({
      items: [payment()],
      documents: [
        document({ id: "inbox-1", date: "2026-03-13" }),
        document({
          id: "inbox-2",
          date: "2026-03-12",
          invoiceNumber: "INV-OPENAI-0002",
        }),
      ],
      bookCurrency: "EUR",
    });

    expect(report.push).toEqual([]);
    expect(report.review.map((r) => r.payment.documentId)).toEqual(["pay-1"]);
    expect(
      report.review[0]?.candidates.map((c) => c.document.id).sort(),
    ).toEqual(["inbox-1", "inbox-2"]);
  });

  it("sends a lone document that is plausible but not convincing to review, not to Yuki", () => {
    // Right supplier, right week, but the amount is about 8% off — a different
    // plan, a partial refund, or simply the wrong receipt.
    const report = reconcileYukiGap({
      items: [payment()],
      documents: [document({ amount: 23.15, baseAmount: 23.15 })],
      bookCurrency: "EUR",
    });

    expect(report.push).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.review[0]?.candidates.map((c) => c.document.id)).toEqual([
      "inbox-1",
    ]);
  });

  it("never pushes one document for two payments", () => {
    // Two identical charges a day apart and a single receipt. Each payment on
    // its own looks like a clean match — but one invoice cannot settle both,
    // and guessing which would book the other one against the wrong document.
    const report = reconcileYukiGap({
      items: [
        payment({ documentId: "pay-1", date: "2026-03-14" }),
        payment({ documentId: "pay-2", date: "2026-03-15" }),
      ],
      documents: [document({ id: "inbox-1", date: "2026-03-13" })],
      bookCurrency: "EUR",
    });

    expect(report.push).toEqual([]);
    expect(report.review.map((r) => r.payment.documentId).sort()).toEqual([
      "pay-1",
      "pay-2",
    ]);
  });

  it("matches a dollar invoice to the euro card charge that paid it", () => {
    // Most SaaS invoices are in dollars and the card is charged in euros.
    // Midday's conversion and the card network's rate never agree to the cent,
    // so the comparison runs on the converted amount, with room for FX drift.
    const report = reconcileYukiGap({
      items: [payment({ openAmount: -21.4 })],
      documents: [
        document({
          amount: 25,
          currency: "USD",
          baseAmount: 21.1,
          baseCurrency: "EUR",
        }),
      ],
      bookCurrency: "EUR",
    });

    expect(report.push.map((p) => p.document.id)).toEqual(["inbox-1"]);
  });

  it("recognises the merchant from the card statement line when Yuki's contact is a catch-all", () => {
    // Yuki sometimes files a card payment under a generic contact; the only
    // trace of the real supplier is the merchant name the card network wrote.
    const report = reconcileYukiGap({
      items: [
        payment({
          contact: "Diverse leveranciers Software",
          description:
            "MASTERCARD - Kaartverrichtingen - CURSOR  AI POWERED IDE  NEW YORK",
          openAmount: -19,
        }),
      ],
      documents: [
        document({
          displayName: "Cursor",
          amount: 19,
          baseAmount: 19,
          website: "cursor.com",
          invoiceNumber: "INV-CURSOR-0001",
        }),
      ],
      bookCurrency: "EUR",
    });

    expect(report.push.map((p) => p.document.id)).toEqual(["inbox-1"]);
  });

  it("leaves Yuki's unpaid invoices alone, because the document is already there", () => {
    const unpaid = payment({
      kind: "unpaid_invoice",
      typeLabel: "Aankoopfactuur",
      documentId: "invoice-1",
      reference: "INV-OPENAI-0001",
    });

    const report = reconcileYukiGap({
      items: [unpaid],
      documents: [document()],
      bookCurrency: "EUR",
    });

    expect(report.push).toEqual([]);
    expect(report.review).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.unpaidInvoices).toBe(1);
  });
});
