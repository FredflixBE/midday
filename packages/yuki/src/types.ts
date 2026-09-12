/**
 * Protocol facts confirmed against a live domain during the FF-1448 spike on
 * 2026-09-10. Each of these was a wrong guess before it was a fact.
 */

/**
 * `DocumentsInFolder` / `ModifiedDocumentsInFolder` sort orders. A string enum:
 * passing an int fails with "'0' is not a valid value for DocumentSortOrder".
 */
export type DocumentSortOrder =
  | "CreatedDesc"
  | "CreatedAsc"
  | "ModifiedDesc"
  | "ModifiedAsc"
  | "DocumentDateDesc"
  | "DocumentDateAsc"
  | "ContactNameAsc"
  | "ContactNameDesc";

/** `OutstandingCreditorItems` / `OutstandingDebtorItems` sort orders. */
export type OutstandingItemsSortOrder =
  | "ContactAsc"
  | "ContactDesc"
  | "AmountAsc"
  | "AmountDesc"
  | "DateAsc"
  | "DateDesc";

/**
 * Yuki's system document folders, for the code that wants to name one.
 *
 * **This is not the list of a domain's folders.** Anything that has to cover
 * the archive asks `DocumentFolders` instead (`archive.ts`): a domain also has
 * folders the team made, and on the one measured on 2026-09-12 those held 44
 * documents, 14 of them carrying a reference. Folder 6 turned out to be one of
 * them — it reports `ProcessedByYuki: "False"` — so even the split between
 * system and user folders is per domain rather than fixed.
 *
 * Note that 7 is "Uitzoeken Yuki" — documents Yuki is still sorting — and not
 * the purchase folder, which an earlier draft of the design assumed.
 */
export const YUKI_FOLDERS = {
  purchase: 1, // Aankoop
  sales: 2, // Verkoop
  bank: 3, // Bank
  personnel: 4, // Personeel
  tax: 5, // Belasting
  insurance: 6, // Verzekering
  toBeSortedByYuki: 7, // Uitzoeken Yuki
  otherFinancial: 8, // Overig financieel
} as const;

/**
 * The `Type` label on an outstanding creditor item.
 *
 * Payments awaiting an invoice are told apart from genuine unpaid invoices by
 * this label — **not** by an absent `DocumentID`, which is populated on every
 * item, payments included.
 *
 * Caution: these are *display labels in the session's language*. Payments come
 * back with an empty `@ID`, so the label is the only discriminator. They were
 * observed on a Dutch-language Belgian domain; a French-language session would
 * very likely return different strings. Anything that matches on them should
 * either pin the session language or fail loudly on an unrecognised label
 * rather than quietly treating it as "not a payment".
 */
export const OUTSTANDING_ITEM_TYPE_LABELS = {
  creditCardPayment: "Creditcardbetaling",
  bankTransaction: "Banktransactie",
  purchaseInvoice: "Aankoopfactuur",
} as const;
