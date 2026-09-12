import type { YukiClient } from "./client";
import {
  OUTSTANDING_ITEM_TYPE_LABELS,
  type OutstandingItemsSortOrder,
} from "./types";

/**
 * What an outstanding creditor item is, as far as the purchase pipeline cares.
 *
 * A payment waiting for its invoice is a gap in the books. An unpaid invoice is
 * not — the document is there, it simply has not been settled.
 */
export type YukiOutstandingItemKind =
  | "payment_awaiting_invoice"
  | "unpaid_invoice";

export interface YukiOutstandingItem {
  kind: YukiOutstandingItemKind;
  /** The label as Yuki sent it, kept for reporting. */
  typeLabel: string;
  /**
   * The item's own id, from the `ID` attribute on the element.
   *
   * For a card payment this is the **id of the ledger line** that booked the
   * payment against the supplier account — verified on 2026-09-12 against all
   * 68 card payments on a live domain, every one of them matching the line the
   * card charge pairs with (FF-1517). That is what lets a charge be told
   * "still waiting for its invoice" without comparing amounts across systems.
   *
   * Distinct from `documentId`, which names the statement the payment was
   * booked from and is shared by every payment on that statement.
   */
  id: string;
  /**
   * Unique per item — confirmed across every payment on a live domain — so it
   * doubles as the item's identity.
   */
  documentId: string;
  date: string;
  contact?: string;
  contactId?: string;
  description?: string;
  /** Signed as Yuki reports it: payments leaving the account are negative. */
  openAmount: number;
  /** The invoice number. Only invoices carry one; payments never do. */
  reference?: string;
}

/**
 * An outstanding item carried a type label this code has not classified.
 *
 * The labels are display strings in the session's language, and payments come
 * back with an empty type id, so the label is the only discriminator. Rather
 * than let an unknown one fall through as "not a gap", the whole parse fails.
 */
export class UnrecognisedOutstandingItemTypeError extends Error {
  readonly labels: string[];

  constructor(labels: string[]) {
    super(
      `Unrecognised outstanding-item type label(s): ${labels.join(", ")}. The Yuki session language may differ from the one these labels were observed in — see OUTSTANDING_ITEM_TYPE_LABELS in @midday/yuki.`,
    );
    this.name = "UnrecognisedOutstandingItemTypeError";
    this.labels = labels;
  }
}

type RawItem = Record<string, unknown>;

const KIND_BY_LABEL: Record<string, YukiOutstandingItemKind> = {
  [OUTSTANDING_ITEM_TYPE_LABELS.creditCardPayment]: "payment_awaiting_invoice",
  [OUTSTANDING_ITEM_TYPE_LABELS.bankTransaction]: "payment_awaiting_invoice",
  [OUTSTANDING_ITEM_TYPE_LABELS.purchaseInvoice]: "unpaid_invoice",
};

/** Yuki repeats `ContactID`, so the parser yields a pair of identical ids. */
function first(value: unknown): string | undefined {
  const picked = Array.isArray(value) ? value[0] : value;
  return typeof picked === "string" && picked !== "" ? picked : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function typeLabelOf(item: RawItem): string {
  const type = item.Type;
  if (typeof type === "string") return type;
  if (type && typeof type === "object") {
    return String((type as Record<string, unknown>)["#text"] ?? "");
  }
  return "";
}

export function parseOutstandingCreditorItems(
  result: unknown,
): YukiOutstandingItem[] {
  const container = (
    result as { OutstandingCreditorItems?: { Item?: unknown } }
  )?.OutstandingCreditorItems?.Item;
  // Several items parse to an array, exactly one to a bare object, and none to
  // an empty string one level up — so `Item` is absent.
  if (!container) return [];
  const raw = (Array.isArray(container) ? container : [container]) as RawItem[];

  const unknown = [
    ...new Set(raw.map(typeLabelOf).filter((label) => !KIND_BY_LABEL[label])),
  ];
  if (unknown.length > 0) {
    throw new UnrecognisedOutstandingItemTypeError(unknown);
  }

  return raw.map((item) => {
    const typeLabel = typeLabelOf(item);
    return {
      kind: KIND_BY_LABEL[typeLabel] as YukiOutstandingItemKind,
      typeLabel,
      id: String(item["@ID"] ?? ""),
      documentId: String(item.DocumentID),
      date: String(item.Date),
      contact: text(item.Contact),
      contactId: first(item.ContactID),
      description: text(item.Description),
      openAmount: Number(item.OpenAmount),
      reference: text(item.Reference),
    };
  });
}

/**
 * Everything outstanding on the creditor side, bank and card transactions
 * included — the payments still waiting for an invoice are what the purchase
 * pipeline exists to fill.
 */
export async function fetchOutstandingCreditorItems(
  client: YukiClient,
): Promise<YukiOutstandingItem[]> {
  return parseOutstandingCreditorItems(
    await client.call("OutstandingCreditorItems", {
      administrationID: client.administrationId,
      includeBankTransactions: true,
      sortOrder: "DateDesc" satisfies OutstandingItemsSortOrder,
    }),
  );
}
