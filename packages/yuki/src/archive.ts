import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import { YukiRequestError } from "./errors";
import type { SoapParams } from "./soap";

/**
 * Reading Yuki's whole document archive, so Midday can ask it questions
 * (FF-1498).
 *
 * Yuki cannot be searched by invoice number: `SearchDocuments` answers
 * `Invalid Tab ID` for every tab tried. It does not have to be, because the
 * archive is small enough to read entire — measured on a real domain on
 * 2026-09-12, **1,815 documents across 12 folders in 15 calls**, against a free
 * allowance of 1,000 calls a day.
 *
 * It is read per run rather than mirrored into a table, because a wrong "Yuki
 * does not hold this" uploads a duplicate into live books that Yuki has no
 * delete operation to remove — so failing to read beats answering from a stale
 * copy. The full argument, and the one fact that would reopen it, is under
 * "Why it is not a table" in this package's README.
 *
 * Everything here is a read, and every operation it issues is on the allowlist
 * in `operations.ts`.
 */

/** What a folder of the archive is, as `DocumentFolders` describes it. */
export interface YukiArchiveFolder {
  id: number;
  description: string;
  /**
   * Yuki's own folders carry `ProcessedByYuki: True`; the ones a user made
   * carry False. Both are read — see {@link listArchiveFolders}.
   */
  processedByYuki: boolean;
}

/**
 * One document of the archive, as the index holds it.
 *
 * The three timestamps stay **exactly the strings Yuki sent**, which look like
 * `2026-09-06T11:30:51` and carry no timezone. Nothing here guesses one. A
 * `Date` built from them would be a claim about which clock Yuki wrote them by,
 * and that claim would be invisible once made — so they stay text, which is
 * honest about knowing only what Yuki said.
 *
 * `amount` is a string for a different reason. It is stored for display only —
 * nothing in this integration may decide on an amount (FF-1493), because
 * cross-currency amounts never compare exactly — and a string is a value you
 * cannot accidentally sum or compare.
 */
export interface YukiArchiveDocument {
  /**
   * Yuki's `@ID`. The same id appears as `DocumentID` on
   * `OutstandingCreditorItems`, which is what lets a document be followed from
   * delivered, to booked, to settled. Unique across folders: all 1,815
   * documents of the measured archive had distinct ids.
   */
  documentId: string;
  folderId: number;
  /**
   * Yuki's numeric type code, as a string. **This is the stable one.** The
   * codes seen on a real archive are `0` Standaard, `1` Elektronisch afschrift,
   * `2` Aankoopfactuur, `6` Verkoopfactuur, `10` Rekeninguittreksel,
   * `14` Btw-aangifte, `21` Diverse posten boeking.
   */
  type: string;
  /**
   * The type's label **in the session's language**. Kept for display and for
   * recognising a code that turns up later, never matched on — the same trap as
   * `OUTSTANDING_ITEM_TYPE_LABELS` in `types.ts`.
   */
  typeDescription: string | null;
  contactName: string | null;
  contactId: string | null;
  /** Yuki's `Reference`, which on an invoice is the invoice number. */
  reference: string | null;
  /**
   * `reference` in its comparable form, or null when there is nothing to
   * compare. This is the value a lookup by invoice number matches on.
   */
  referenceNormalized: string | null;
  /** `YYYY-MM-DD`. For display; nothing decides on it. */
  documentDate: string | null;
  /** Yuki's own decimal string. For display; nothing decides on it. */
  amount: string | null;
  createdInYuki: string | null;
  creator: string | null;
  /** Present on every document seen. For display; nothing decides on it. */
  modifiedInYuki: string | null;
  fileName: string | null;
}

/**
 * The document types that make a reference an *invoice* number.
 *
 * The ones Yuki produced on a real archive: purchase invoices in Aankoop, sales
 * invoices in Verkoop. The codes are language-independent, unlike the labels.
 *
 * This matters more than it looks. 884 documents of the measured archive carry
 * a reference, and 106 of them are not invoices — a bank statement, a VAT
 * return and a journal entry carry a `Reference` too, and 9 of those share a
 * number with a real invoice. Without this filter, "does Yuki already hold this
 * invoice?" would sometimes be answered by a bank statement.
 *
 * The filter cuts the other way too, which is what {@link YukiArchive.findDocuments}
 * is for: 97 documents carry a number that no invoice carries.
 */
export const YUKI_INVOICE_DOCUMENT_TYPES = {
  purchaseInvoice: "2",
  salesInvoice: "6",
} as const;

const INVOICE_TYPES: ReadonlySet<string> = new Set(
  Object.values(YUKI_INVOICE_DOCUMENT_TYPES),
);

/**
 * Whether a document of this type counts as "Yuki holds this invoice".
 *
 * A quote, a contract or a reminder with the same number does not — and neither
 * does a bank statement that happens to reuse it.
 */
export function isInvoiceDocumentType(type: string): boolean {
  return INVOICE_TYPES.has(type);
}

/**
 * The `modifiedSince` that reads a folder entire.
 *
 * `ModifiedDocumentsInFolder` from here returns the folder's **whole**
 * contents — verified against Aankoop, which answered with all 722 of its
 * documents.
 *
 * It is the operation used for a full read because the alternative,
 * `DocumentsInFolder`, is bounded by a start and an end date. A date window is
 * a way to miss a document: the spike's check of the last 120 days of the
 * purchase folder missed an OpenAI invoice from January that Yuki already held,
 * and would have uploaded a duplicate. "Everything modified since 2000" has no
 * window to fall outside of.
 */
export const YUKI_ARCHIVE_EPOCH = "2000-01-01T00:00:00";

/** How many documents one call asks for. 500 reads the largest folder in two. */
const YUKI_ARCHIVE_PAGE_SIZE = 500;

/**
 * A bound on the paging, so a folder that never ends cannot spend the day's
 * whole allowance.
 *
 * The loop's only stop condition is a page shorter than the one asked for,
 * because Yuki reports no total. That is correct as long as `startRecord`
 * advances the window — and if it ever did not, the loop would ask the same
 * question forever at several calls a second. 40 pages of 500 is 20,000
 * documents, against a real archive of 1,815.
 */
const MAX_PAGES_PER_FOLDER = 40;

/**
 * The slice of {@link YukiClient} this module needs.
 *
 * Declared structurally so the paging can be tested against a recorded
 * response without a client, a session or a network.
 */
export interface YukiArchiveReader {
  call(operation: string, params?: SoapParams): Promise<unknown>;
}

/**
 * Yuki answers an empty list with `""` rather than an absent element, and a
 * list of one with the element itself rather than an array of one.
 */
function asRecords(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

/** A field Yuki may omit, may send empty, and always sends as a string. */
function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function required(
  record: Record<string, unknown>,
  key: string,
  operation: string,
): string {
  const value = text(record, key);
  if (!value) {
    throw new YukiRequestError({
      operation,
      message: `${operation} returned a document with no ${key}. The archive index keys on it, so the response cannot be trusted.`,
    });
  }
  return value;
}

/**
 * Parses a `DocumentFolders` response.
 *
 * Wrapped as `{ DocumentFolders: { DocumentFolder: [...] } }`.
 */
export function parseArchiveFolders(result: unknown): YukiArchiveFolder[] {
  const wrapper = (result as { DocumentFolders?: unknown })?.DocumentFolders;
  const records = asRecords(
    (wrapper as { DocumentFolder?: unknown })?.DocumentFolder,
  );

  return records.map((record) => {
    const id = required(record, "@ID", "DocumentFolders");
    const numeric = Number(id);

    if (!Number.isInteger(numeric)) {
      throw new YukiRequestError({
        operation: "DocumentFolders",
        message: `DocumentFolders returned a folder whose id is not a number: "${id}".`,
      });
    }

    return {
      id: numeric,
      description: text(record, "Description") ?? "",
      processedByYuki:
        (text(record, "ProcessedByYuki") ?? "").toLowerCase() === "true",
    };
  });
}

/**
 * Parses one page of `DocumentsInFolder` or `ModifiedDocumentsInFolder`.
 *
 * Wrapped as `{ Documents: { Document: [...] } }`, and `{ Documents: "" }` when
 * the folder has nothing to show.
 */
export function parseArchiveDocuments(
  result: unknown,
  folderId: number,
): YukiArchiveDocument[] {
  const operation = "ModifiedDocumentsInFolder";

  const wrapper = (result as { Documents?: unknown })?.Documents;
  const records = asRecords((wrapper as { Document?: unknown })?.Document);

  return records.map((record) => {
    const reference = text(record, "Reference");

    return {
      documentId: required(record, "@ID", operation),
      folderId,
      type: required(record, "Type", operation),
      typeDescription: text(record, "TypeDescription"),
      contactName: text(record, "ContactName"),
      contactId: text(record, "ContactId"),
      reference,
      referenceNormalized: reference
        ? comparableInvoiceReference(reference)
        : null,
      documentDate: text(record, "DocumentDate"),
      amount: text(record, "Amount"),
      createdInYuki: text(record, "Created"),
      creator: text(record, "Creator"),
      modifiedInYuki: text(record, "Modified"),
      fileName: text(record, "FileName"),
    };
  });
}

/** Every folder of the archive, Yuki's own and the ones a user made. */
export async function listArchiveFolders(
  client: YukiArchiveReader,
): Promise<YukiArchiveFolder[]> {
  return parseArchiveFolders(await client.call("DocumentFolders"));
}

export interface ReadArchiveFolderResult {
  documents: YukiArchiveDocument[];
  /** How many calls it took, for the call allowance. */
  calls: number;
}

/** Reads one folder entire, following the pages. */
export async function readArchiveFolder(
  client: YukiArchiveReader,
  params: {
    folderId: number;
    pageSize?: number;
  },
): Promise<ReadArchiveFolderResult> {
  const { folderId, pageSize = YUKI_ARCHIVE_PAGE_SIZE } = params;

  const documents: YukiArchiveDocument[] = [];
  let startRecord = 0;
  let calls = 0;

  while (calls < MAX_PAGES_PER_FOLDER) {
    const page = parseArchiveDocuments(
      await client.call("ModifiedDocumentsInFolder", {
        folderID: folderId,
        sortOrder: "ModifiedAsc",
        modifiedSince: YUKI_ARCHIVE_EPOCH,
        numberOfRecords: pageSize,
        startRecord,
      }),
      folderId,
    );
    calls++;
    documents.push(...page);

    // A short page is the last page. Yuki reports no total, so this is the
    // only end marker there is.
    if (page.length < pageSize) break;
    startRecord += pageSize;
  }

  if (calls >= MAX_PAGES_PER_FOLDER) {
    throw new YukiRequestError({
      operation: "ModifiedDocumentsInFolder",
      message: `Folder ${folderId} did not end after ${MAX_PAGES_PER_FOLDER} pages of ${pageSize}. Rather than keep asking, this stops: the only way the loop does not end is if Yuki ignores startRecord and returns the same full page forever, and that would spend the day's 1,000 calls in under a minute.`,
    });
  }

  return { documents, calls };
}

/**
 * The archive as one run of a job holds it: every document, and the lookup the
 * purchase side actually asks.
 *
 * This is what replaced the table. It is built once per run and passed to the
 * steps that need it, rather than each step reading Yuki again — fifteen calls
 * is cheap against 1,000 a day, but it is not free, and two steps of one run
 * should not be able to see two different archives.
 */
export interface YukiArchive {
  readonly folders: readonly YukiArchiveFolder[];
  readonly documents: readonly YukiArchiveDocument[];
  /** How many calls the read cost, against the free allowance of 1,000 a day. */
  readonly calls: number;
  /**
   * When the read finished.
   *
   * Everything here is exactly this old. A caller that acts on the archive
   * should be reading it within the same run — if this is ever far in the past,
   * something is holding an archive across runs, which is the mirror this
   * design rejected, rebuilt by accident.
   */
  readonly readAt: Date;
  /**
   * The invoice documents carrying this number, comparing normalised (FF-1493):
   * `#SBIE-1234` and `sbie 1234` are one number.
   *
   * Empty means **Yuki does not hold this invoice**, which is the answer the
   * purchase side acts on, so two things it deliberately does not do:
   *
   * It does not match non-invoice documents. A bank statement, a VAT return and
   * a journal entry all carry a `Reference` too, and on the measured archive 9
   * of those collided with a real invoice number — enough for "is this invoice
   * in Yuki?" to be answered yes by a bank statement.
   *
   * It does not match a reference with nothing comparable in it. A reference of
   * only punctuation normalises to the empty string, and an empty string equals
   * every other empty string, so accepting one would report that Yuki already
   * holds every unnumbered document it has.
   *
   * It answers with a list because a number genuinely can sit on more than one
   * invoice — four did on the measured archive, each time on documents of the
   * same contact. Whether that is the same invoice twice is the caller's
   * judgement, not a lookup's.
   */
  findInvoices(reference: string): readonly YukiArchiveDocument[];
  /**
   * Every document carrying this number, **of any type**.
   *
   * This exists because "no invoice has this number" and "Yuki has never seen
   * this number" are different answers, and only one of them means *send it*.
   *
   * Measured on the live archive: the purchase folder holds 5 documents of
   * `Type` 0 (Standaard), 3 of them carrying a reference, and the folder the
   * team sorts by hand holds 30 more with 13 references. A document that has
   * arrived but has not yet been classified as an invoice looks exactly like
   * that — which is the state a freshly delivered invoice passes through.
   *
   * So a caller that only asked {@link findInvoices} would be told "not in
   * Yuki" about a document Yuki is holding, and would deliver it a second time.
   * Yuki has no delete operation, so that duplicate is permanent. When this
   * answers something and `findInvoices` answers nothing, the honest outcome is
   * FF-1493's *Needs attention*, not *send*.
   */
  findDocuments(reference: string): readonly YukiArchiveDocument[];
}

/**
 * Builds the lookup over documents already read. Separate from the reading so
 * it can be tested on a fixture without a client, a session or a network.
 */
export function buildYukiArchive(params: {
  folders: readonly YukiArchiveFolder[];
  documents: readonly YukiArchiveDocument[];
  calls: number;
  readAt?: Date;
}): YukiArchive {
  const { folders, documents, calls, readAt = new Date() } = params;

  const byReference = new Map<string, YukiArchiveDocument[]>();

  for (const document of documents) {
    if (!document.referenceNormalized) continue;

    const held = byReference.get(document.referenceNormalized);
    if (held) held.push(document);
    else byReference.set(document.referenceNormalized, [document]);
  }

  function matching(reference: string): readonly YukiArchiveDocument[] {
    const comparable = comparableInvoiceReference(reference);
    if (!comparable) return [];
    return byReference.get(comparable) ?? [];
  }

  return {
    folders,
    documents,
    calls,
    readAt,
    findInvoices(reference) {
      return matching(reference).filter((d) => isInvoiceDocumentType(d.type));
    },
    findDocuments: matching,
  };
}

/**
 * Reads the whole archive: which folders exist, then each of them entire.
 *
 * The folders are asked for rather than assumed. `YUKI_FOLDERS` is Yuki's
 * system set, and a domain also has folders the team made — on the one measured
 * they held 44 documents, 14 carrying a reference, and folder 6 turned out to
 * be one of them. A read that covered only the known folders would miss those,
 * and missing a document means uploading it again.
 */
export async function readYukiArchive(
  client: YukiArchiveReader,
  options: { pageSize?: number } = {},
): Promise<YukiArchive> {
  const folders = await listArchiveFolders(client);
  const documents: YukiArchiveDocument[] = [];
  let calls = 1;

  for (const folder of folders) {
    const read = await readArchiveFolder(client, {
      folderId: folder.id,
      pageSize: options.pageSize,
    });

    documents.push(...read.documents);
    calls += read.calls;
  }

  return buildYukiArchive({ folders, documents, calls });
}
