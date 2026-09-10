/**
 * The allowlist. This is the safety property of the whole package.
 *
 * Yuki exposes no delete operation in any of its services — Archive,
 * AccountingInfo, Accounting and BackOffice were all checked. Anything
 * uploaded or booked can only be removed by a human in the Yuki UI. There is
 * also no sandbox, so development happens against real books.
 *
 * So the client refuses to issue any operation that is not explicitly a read.
 * Writes are opted into one at a time, by name, when a caller genuinely needs
 * one — see `YukiClientConfig.allowWriteOperations`.
 */

export type YukiService =
  | "Archive"
  | "Accounting"
  | "AccountingInfo"
  | "BackOffice"
  | "Contact"
  | "Sales"
  | "Purchase"
  | "Upload";

/**
 * Every operation the client may issue without an explicit opt-in, mapped to
 * the service that hosts it.
 *
 * Signatures marked "confirmed" were read off the published .asmx operation
 * pages. The rest are inferred from Yuki's support documentation and may have
 * the parameter names slightly wrong — a wrong name comes back as a SOAP fault
 * naming the parameter, so the first exploration run will surface it.
 */
export const READ_OPERATIONS = {
  // --- session / directory (confirmed) ---
  Authenticate: "Archive",
  Administrations: "Archive",
  AdministrationID: "Archive",
  GetCurrentDomain: "Archive",
  Domains: "Archive",

  // --- Archive: documents ---
  DocumentFolders: "Archive",
  DocumentFolderTabs: "Archive",
  DocumentFolderCounts: "Archive",
  Documents: "Archive",
  DocumentsInFolder: "Archive",
  DocumentsInTab: "Archive",
  DocumentsByType: "Archive",
  ModifiedDocumentsInFolder: "Archive",
  ModifiedDocumentsByType: "Archive",
  SearchDocuments: "Archive",
  FindDocument: "Archive",
  DocumentBinaryData: "Archive",
  DocumentXMLData: "Archive",
  DocumentXMLDataAsString: "Archive",
  DocumentDownloadUrl: "Archive",
  CostCategories: "Archive",
  Currencies: "Archive",
  PaymentMethods: "Archive",

  // --- Accounting: ledger and outstanding items ---
  GLAccountTransactions: "Accounting",
  GLAccountBalance: "Accounting",
  OutstandingCreditorItems: "Accounting",
  OutstandingDebtorItems: "Accounting",
  CheckOutstandingItem: "Accounting",
  NetRevenue: "Accounting",

  // --- AccountingInfo ---
  GetTransactions: "AccountingInfo",
  GetTransactionDetails: "AccountingInfo",
  GetGLAccountScheme: "AccountingInfo",
  GetPeriodDateTable: "AccountingInfo",

  // --- BackOffice: the workflow FF-1493 is built on ---
  GetWorkflow: "BackOffice",
  GetOutstandingQuestions: "BackOffice",
} as const satisfies Record<string, YukiService>;

export type ReadOperation = keyof typeof READ_OPERATIONS;

/**
 * Operations known to change state in Yuki. Listed explicitly so that an
 * attempt to call one produces a message saying *why* it is blocked, rather
 * than the generic "not in the allowlist".
 *
 * `DocumentBinaryData` is a read despite the POST; `UploadDocument` is not.
 */
export const WRITE_OPERATIONS = [
  "UploadDocument",
  "UploadDocumentWithData",
  "UploadDocumentWithAttachment",
  "ProcessSalesInvoices",
  "ProcessPurchaseInvoices",
  "ProcessJournal",
  "ProcessPettyCash",
  "UpdateContact",
  "CreateContact",
] as const;

export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

/** Which service hosts each write, for when one is deliberately enabled. */
export const WRITE_OPERATION_SERVICES = {
  UploadDocument: "Upload",
  UploadDocumentWithData: "Archive",
  UploadDocumentWithAttachment: "Archive",
  ProcessSalesInvoices: "Sales",
  ProcessPurchaseInvoices: "Purchase",
  ProcessJournal: "Accounting",
  ProcessPettyCash: "Upload",
  UpdateContact: "Contact",
  CreateContact: "Contact",
} as const satisfies Record<WriteOperation, YukiService>;

export function isReadOperation(operation: string): operation is ReadOperation {
  return Object.hasOwn(READ_OPERATIONS, operation);
}

export function isKnownWriteOperation(
  operation: string,
): operation is WriteOperation {
  return (WRITE_OPERATIONS as readonly string[]).includes(operation);
}

/** The service hosting an operation, read or write. */
export function serviceFor(operation: string): YukiService | undefined {
  if (isReadOperation(operation)) return READ_OPERATIONS[operation];
  if (isKnownWriteOperation(operation)) {
    return WRITE_OPERATION_SERVICES[operation];
  }
  return undefined;
}
