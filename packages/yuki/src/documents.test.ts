import { describe, expect, it } from "bun:test";
import { fetchDocumentBinary, MAX_DOCUMENT_BYTES } from "./documents";
import { YukiRequestError } from "./errors";
import type { SoapParams } from "./soap";

function reader(answer: unknown) {
  const calls: { operation: string; params?: SoapParams }[] = [];

  return {
    calls,
    async call(operation: string, params?: SoapParams) {
      calls.push({ operation, params });
      return answer;
    },
  };
}

describe("fetchDocumentBinary", () => {
  it("decodes what Yuki sends, which is base64 in a string", async () => {
    // The first bytes of every purchase invoice in the measured archive.
    const pdf = Buffer.from("%PDF-1.5\nhello");
    const client = reader(pdf.toString("base64"));

    const bytes = await fetchDocumentBinary(client, { documentId: "doc-1" });

    expect(Buffer.from(bytes).toString()).toBe("%PDF-1.5\nhello");
  });

  it("asks with documentID, the one spelling Yuki accepts", async () => {
    const client = reader(Buffer.from("%PDF").toString("base64"));

    await fetchDocumentBinary(client, { documentId: "doc-1" });

    expect(client.calls).toEqual([
      { operation: "DocumentBinaryData", params: { documentID: "doc-1" } },
    ]);
  });

  it("throws for a document Yuki does not have, which answers empty", async () => {
    // Measured: an id that is not in the domain comes back as "". A zero-byte
    // file in the vault would look like a document and open to nothing.
    const client = reader("");

    await expect(
      fetchDocumentBinary(client, { documentId: "missing" }),
    ).rejects.toBeInstanceOf(YukiRequestError);
  });

  it("throws rather than trusting a response that is not a string", async () => {
    const client = reader({ Documents: "" });

    await expect(
      fetchDocumentBinary(client, { documentId: "doc-1" }),
    ).rejects.toBeInstanceOf(YukiRequestError);
  });

  it("throws for something that is not base64, rather than a short file", async () => {
    // Buffer.from drops characters outside the alphabet instead of failing, so
    // an error page would otherwise be stored as a few bytes of nonsense.
    const client = reader("!!!!");

    await expect(
      fetchDocumentBinary(client, { documentId: "doc-1" }),
    ).rejects.toBeInstanceOf(YukiRequestError);
  });

  it("refuses a document too large to hold in memory twice", async () => {
    const client = reader("A".repeat(MAX_DOCUMENT_BYTES * 2));

    await expect(
      fetchDocumentBinary(client, { documentId: "doc-1" }),
    ).rejects.toBeInstanceOf(YukiRequestError);
  });
});
