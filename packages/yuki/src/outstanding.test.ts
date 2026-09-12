import { describe, expect, it } from "bun:test";
import {
  parseOutstandingCreditorItems,
  UnrecognisedOutstandingItemTypeError,
} from "./outstanding";

// Shaped like a live OutstandingCreditorItems response. Every amount, date
// and id here is invented — this repository is public.
const cardPayment = {
  Date: "2026-03-14",
  Description:
    "MASTERCARD - Kaartverrichtingen - OPENAI  CHATGPT SUBSCR  SAN FRAN",
  Contact: "OpenAI",
  ContactID: ["contact-openai", "contact-openai"],
  OpenAmount: "-21.40",
  OriginalAmount: "-21.40",
  Type: { "#text": "Creditcardbetaling", "@ID": "" },
  DueDate: "2026-03-14",
  DocumentID: "doc-card-1",
  // The item's own id is the ledger line that booked the payment against the
  // supplier account — what pairs it with a card charge (FF-1517).
  "@ID": "ledger-line-card-1",
};

describe("parseOutstandingCreditorItems", () => {
  it("reads a card payment as a payment still waiting for its invoice", () => {
    const [item] = parseOutstandingCreditorItems({
      OutstandingCreditorItems: { Item: [cardPayment] },
    });

    expect(item).toEqual({
      kind: "payment_awaiting_invoice",
      typeLabel: "Creditcardbetaling",
      id: "ledger-line-card-1",
      documentId: "doc-card-1",
      date: "2026-03-14",
      contact: "OpenAI",
      contactId: "contact-openai",
      description:
        "MASTERCARD - Kaartverrichtingen - OPENAI  CHATGPT SUBSCR  SAN FRAN",
      openAmount: -21.4,
      reference: undefined,
    });
  });

  it("tells an unpaid invoice apart from a gap, and keeps its invoice number", () => {
    const unpaidInvoice = {
      Date: "2026-03-02",
      Description: "Factuur van Voorbeeld Telecom",
      Contact: "Voorbeeld Telecom",
      ContactID: ["contact-telecom", "contact-telecom"],
      OpenAmount: "64.10",
      OriginalAmount: "64.10",
      Type: { "#text": "Aankoopfactuur", "@ID": "2" },
      Reference: "INV-000123",
      DocumentID: "doc-invoice-1",
    };

    const items = parseOutstandingCreditorItems({
      OutstandingCreditorItems: { Item: [cardPayment, unpaidInvoice] },
    });

    expect(items.map((i) => [i.documentId, i.kind, i.reference])).toEqual([
      ["doc-card-1", "payment_awaiting_invoice", undefined],
      ["doc-invoice-1", "unpaid_invoice", "INV-000123"],
    ]);
  });

  it("reads a lone item, which the XML parser returns as an object rather than an array", () => {
    const items = parseOutstandingCreditorItems({
      OutstandingCreditorItems: { Item: cardPayment },
    });
    expect(items.map((i) => i.documentId)).toEqual(["doc-card-1"]);
  });

  it("reads an administration with nothing outstanding as an empty list", () => {
    // Yuki sends an empty element; the parser turns that into "".
    expect(
      parseOutstandingCreditorItems({ OutstandingCreditorItems: "" }),
    ).toEqual([]);
  });

  it("refuses to guess at a type label it has never seen", () => {
    // Labels are display strings in the session's language, and payments carry
    // no stable id beside them. An unknown label means the classification can
    // no longer be trusted, so the whole parse fails rather than quietly
    // treating the item as something that is not a gap.
    const french = {
      ...cardPayment,
      Type: { "#text": "Paiement par carte de crédit", "@ID": "" },
    };

    expect(() =>
      parseOutstandingCreditorItems({
        OutstandingCreditorItems: { Item: [cardPayment, french] },
      }),
    ).toThrow(UnrecognisedOutstandingItemTypeError);
  });
});
