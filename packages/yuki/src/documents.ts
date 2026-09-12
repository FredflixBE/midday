import { YukiRequestError } from "./errors";
import type { SoapParams } from "./soap";

/**
 * Fetching the file behind an archive document (FF-1450).
 *
 * `archive.ts` answers *what* Yuki holds; this answers *the document itself*,
 * so that a purchase invoice Yuki has and Midday does not can be stored in
 * Midday's own vault and shown next to its transaction.
 *
 * It is a read. `DocumentBinaryData` is a POST, like every ASMX operation, but
 * it changes nothing in Yuki and it is on the read allowlist for that reason.
 */

/** The slice of the client this needs, so a test can stand in for it. */
export interface YukiDocumentReader {
  call(operation: string, params?: SoapParams): Promise<unknown>;
}

/**
 * How large a document may be before this refuses to decode it.
 *
 * The whole file arrives base64'd inside a SOAP envelope, so it is in memory
 * twice over — as text and again as bytes — and a job runs several of these at
 * a time on a small machine. 25 MB is far above anything the measured archive
 * holds (the largest purchase invoice is under 3 MB) and far below what would
 * put a worker in trouble.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * One document's bytes.
 *
 * **The parameter is `documentID`**, confirmed against a live domain on
 * 2026-09-12: `documentId` and `DocumentID` both come back as the SOAP fault
 * `Invalid document ID`, because ASMX validates the element name and Yuki then
 * reads an absent id. The result is base64 in a plain string element, and the
 * first bytes of a purchase invoice decode to `%PDF`.
 *
 * Yuki reports "no such document" the same way it reports an empty one — an
 * empty string, measured on an id that is not in the domain. Both throw here
 * rather than answering zero bytes, because a
 * zero-byte file stored in the vault is a document that looks present and
 * opens to nothing, and the only sign of it would be someone clicking it.
 */
export async function fetchDocumentBinary(
  client: YukiDocumentReader,
  params: { documentId: string },
): Promise<Uint8Array> {
  const result = await client.call("DocumentBinaryData", {
    documentID: params.documentId,
  });

  if (typeof result !== "string" || result.trim() === "") {
    throw new YukiRequestError({
      operation: "DocumentBinaryData",
      message: `DocumentBinaryData returned no data for document ${params.documentId}. Either the id is not in this administration, or the document has no file.`,
    });
  }

  // The base64 is ~4/3 of the bytes it encodes, so this rejects an oversized
  // document without allocating the decoded copy of it.
  if (result.length > MAX_DOCUMENT_BYTES * 1.4) {
    throw new YukiRequestError({
      operation: "DocumentBinaryData",
      message: `Document ${params.documentId} is larger than the ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB this will decode.`,
    });
  }

  const bytes = Buffer.from(result, "base64");

  // Buffer.from ignores anything that is not base64 rather than throwing, so
  // a truncated or non-base64 response would otherwise become a short file.
  if (bytes.length === 0) {
    throw new YukiRequestError({
      operation: "DocumentBinaryData",
      message: `DocumentBinaryData returned something for document ${params.documentId} that is not base64.`,
    });
  }

  return new Uint8Array(bytes);
}
