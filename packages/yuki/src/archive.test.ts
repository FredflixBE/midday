import { describe, expect, it } from "bun:test";
import {
  buildYukiArchive,
  isInvoiceDocumentType,
  listArchiveFolders,
  parseArchiveDocuments,
  parseArchiveFolders,
  readArchiveFolder,
  readYukiArchive,
  YUKI_ARCHIVE_EPOCH,
  type YukiArchiveDocument,
  type YukiArchiveReader,
} from "./archive";
import { YukiRequestError } from "./errors";

/**
 * Fixtures are invented — the suppliers, numbers and amounts below are not
 * anyone's books. Only the *shape* is real, read off a live domain on
 * 2026-09-12: `{ Documents: { Document: [...] } }`, a bare object for a list of
 * one, and `""` for a list of none.
 */
function document(overrides: Record<string, unknown> = {}) {
  return {
    Subject: "Factuur van Acme, Kantoorbenodigdheden",
    DocumentDate: "2026-09-06",
    Amount: "78.65",
    Type: "2",
    TypeDescription: "Aankoopfactuur",
    FileName: "Acme BV - INV-1001.pdf",
    ContentType: "application/pdf",
    FileSize: "377847",
    ContactName: "Acme",
    ContactId: "11111111-1111-4111-8111-111111111111",
    Reference: "INV-1001",
    VATAmount: "13.65",
    Created: "2026-09-06T11:30:51",
    Creator: "yuki",
    Modified: "2026-09-06T11:31:38",
    Modifier: "yuki",
    "@ID": "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

const documents = (...records: Record<string, unknown>[]) => ({
  Documents: { Document: records.length === 1 ? records[0] : records },
});

describe("parseArchiveDocuments", () => {
  it("keeps the fields the index is made of", () => {
    const [parsed] = parseArchiveDocuments(documents(document()), 1);

    expect(parsed).toEqual({
      documentId: "22222222-2222-4222-8222-222222222222",
      folderId: 1,
      type: "2",
      typeDescription: "Aankoopfactuur",
      contactName: "Acme",
      contactId: "11111111-1111-4111-8111-111111111111",
      reference: "INV-1001",
      referenceNormalized: "INV1001",
      documentDate: "2026-09-06",
      amount: "78.65",
      createdInYuki: "2026-09-06T11:30:51",
      creator: "yuki",
      modifiedInYuki: "2026-09-06T11:31:38",
      fileName: "Acme BV - INV-1001.pdf",
    });
  });

  it("leaves Yuki's timestamps exactly as Yuki wrote them", () => {
    // No timezone is invented on the way in: a Date would be a claim about
    // which clock Yuki wrote by, and it would be invisible once made.
    const [parsed] = parseArchiveDocuments(documents(document()), 1);

    expect(parsed?.modifiedInYuki).toBe("2026-09-06T11:31:38");
    expect(parsed?.createdInYuki).toBe("2026-09-06T11:30:51");
  });

  it("reads a list of one, which Yuki sends unwrapped", () => {
    const parsed = parseArchiveDocuments(
      { Documents: { Document: document() } },
      1,
    );

    expect(parsed).toHaveLength(1);
  });

  it("reads an empty folder, which Yuki answers with an empty string", () => {
    expect(parseArchiveDocuments({ Documents: "" }, 4)).toEqual([]);
    expect(parseArchiveDocuments({}, 4)).toEqual([]);
    expect(parseArchiveDocuments(undefined, 4)).toEqual([]);
  });

  it("normalises the reference, so one number written twice is one number", () => {
    const [hashed] = parseArchiveDocuments(
      documents(document({ Reference: "#SBIE-1234" })),
      1,
    );
    const [plain] = parseArchiveDocuments(
      documents(document({ Reference: "sbie 1234" })),
      1,
    );

    expect(hashed?.referenceNormalized).toBe("SBIE1234");
    expect(plain?.referenceNormalized).toBe("SBIE1234");
  });

  it("leaves the normalised reference null when there is nothing to compare", () => {
    // 900 of the archive's 1,815 documents have no reference at all — bank
    // statements, VAT returns. A row that matched the empty string would
    // answer "Yuki already has this" for every one of them.
    const [none] = parseArchiveDocuments(
      documents(document({ Reference: "" })),
      3,
    );
    const [punctuation] = parseArchiveDocuments(
      documents(document({ Reference: "--/--" })),
      3,
    );

    expect(none?.reference).toBeNull();
    expect(none?.referenceNormalized).toBeNull();
    expect(punctuation?.reference).toBe("--/--");
    expect(punctuation?.referenceNormalized).toBeNull();
  });

  it("refuses a document with no id rather than indexing it", () => {
    // Silently dropping it would make "Yuki does not have this invoice" true
    // for a document Yuki does have, and Yuki cannot delete an upload.
    expect(() =>
      parseArchiveDocuments(documents(document({ "@ID": "" })), 1),
    ).toThrow(YukiRequestError);
  });

  it("refuses a document with no type, which is what makes it an invoice", () => {
    expect(() =>
      parseArchiveDocuments(documents(document({ Type: undefined })), 1),
    ).toThrow(YukiRequestError);
  });
});

describe("isInvoiceDocumentType", () => {
  it("counts purchase and sales invoices", () => {
    expect(isInvoiceDocumentType("2")).toBe(true);
    expect(isInvoiceDocumentType("6")).toBe(true);
  });

  it("counts nothing else, including the types that carry a reference", () => {
    // A bank statement, a journal entry and a plain document all have a
    // `Reference`, and nine of them share one with an invoice.
    for (const type of ["0", "1", "10", "14", "21", "999"]) {
      expect(isInvoiceDocumentType(type)).toBe(false);
    }
  });
});

describe("parseArchiveFolders", () => {
  const folders = {
    DocumentFolders: {
      DocumentFolder: [
        {
          Description: "Aankoop",
          ProcessedByYuki: "True",
          "@ID": "1",
        },
        {
          Description: "Zelf te ordenen",
          ProcessedByYuki: "False",
          "@ID": "100",
        },
        { Description: "Overig", ProcessedByYuki: "False", "@ID": "0" },
      ],
    },
  };

  it("reads every folder, Yuki's own and the ones a user made", () => {
    // The user folders are the reason the folder list is asked for rather
    // than hard-coded: folder 100 held 44 documents on the real archive, and
    // 14 of them carry a reference.
    expect(parseArchiveFolders(folders)).toEqual([
      { id: 1, description: "Aankoop", processedByYuki: true },
      { id: 100, description: "Zelf te ordenen", processedByYuki: false },
      { id: 0, description: "Overig", processedByYuki: false },
    ]);
  });

  it("refuses a folder id that is not a number", () => {
    expect(() =>
      parseArchiveFolders({
        DocumentFolders: { DocumentFolder: { Description: "x", "@ID": "abc" } },
      }),
    ).toThrow(YukiRequestError);
  });
});

/** A reader that answers from a script of pages, and records what it was asked. */
function fakeReader(pages: Record<string, unknown>[]): YukiArchiveReader & {
  requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  let index = 0;

  return {
    requests,
    async call(operation, params) {
      requests.push({ operation, ...params });
      return pages[index++] ?? { Documents: "" };
    },
  };
}

describe("readArchiveFolder", () => {
  it("asks Yuki for the folder entire, from the epoch", async () => {
    // Every read is a full read: there is no cursor, because there is nothing
    // stored between runs for a cursor to continue from.
    const reader = fakeReader([documents(document())]);

    const result = await readArchiveFolder(reader, {
      folderId: 1,
      pageSize: 2,
    });

    expect(reader.requests).toEqual([
      {
        operation: "ModifiedDocumentsInFolder",
        folderID: 1,
        sortOrder: "ModifiedAsc",
        modifiedSince: YUKI_ARCHIVE_EPOCH,
        numberOfRecords: 2,
        startRecord: 0,
      },
    ]);
    expect(result.documents).toHaveLength(1);
  });

  it("follows the pages until one comes back short", async () => {
    const reader = fakeReader([
      documents(
        document({ "@ID": "a", Modified: "2026-01-01T00:00:00" }),
        document({ "@ID": "b", Modified: "2026-01-02T00:00:00" }),
      ),
      documents(document({ "@ID": "c", Modified: "2026-01-03T00:00:00" })),
    ]);

    const result = await readArchiveFolder(reader, {
      folderId: 1,
      pageSize: 2,
    });

    expect(result.documents.map((d) => d.documentId)).toEqual(["a", "b", "c"]);
    expect(result.calls).toBe(2);
    expect(reader.requests.map((r) => r.startRecord)).toEqual([0, 2]);
  });

  it("asks once more when the last page was exactly full", async () => {
    // A full page is indistinguishable from a full page with more behind it;
    // Yuki reports no total.
    const reader = fakeReader([
      documents(document({ "@ID": "a" })),
      { Documents: "" },
    ]);

    const result = await readArchiveFolder(reader, {
      folderId: 1,
      pageSize: 1,
    });

    expect(result.calls).toBe(2);
    expect(result.documents).toHaveLength(1);
  });

  it("stops rather than page forever if Yuki ignores startRecord", async () => {
    // The loop's only end marker is a short page. If Yuki answered every page
    // with the same full one, an unbounded loop would spend the day's 1,000
    // calls in under a minute.
    const alwaysFull: YukiArchiveReader = {
      call: async () => documents(document({ "@ID": "a" })),
    };

    expect(
      readArchiveFolder(alwaysFull, { folderId: 1, pageSize: 1 }),
    ).rejects.toThrow(YukiRequestError);
  });

  it("reads an empty folder without complaining", async () => {
    const reader = fakeReader([{ Documents: "" }]);

    const result = await readArchiveFolder(reader, { folderId: 4 });

    expect(result.documents).toEqual([]);
    expect(result.calls).toBe(1);
  });
});

describe("listArchiveFolders", () => {
  it("asks for the folders rather than assuming which exist", async () => {
    const reader = fakeReader([
      {
        DocumentFolders: {
          DocumentFolder: {
            Description: "Aankoop",
            ProcessedByYuki: "True",
            "@ID": "1",
          },
        },
      },
    ]);

    expect(await listArchiveFolders(reader)).toEqual([
      { id: 1, description: "Aankoop", processedByYuki: true },
    ]);
    expect(reader.requests[0]).toEqual({ operation: "DocumentFolders" });
  });
});

/** One document as the parser produces it, so the normalisation is the real one. */
function parsed(
  overrides: Record<string, unknown> = {},
  folderId = 1,
): YukiArchiveDocument {
  const [only] = parseArchiveDocuments(
    documents(document(overrides)),
    folderId,
  );
  if (!only) throw new Error("fixture produced no document");
  return only;
}

function archiveOf(...docs: YukiArchiveDocument[]) {
  return buildYukiArchive({ folders: [], documents: docs, calls: 0 });
}

describe("findInvoices", () => {
  it("finds the invoice carrying the number", () => {
    const archive = archiveOf(parsed({ "@ID": "a", Reference: "INV-1001" }));

    expect(archive.findInvoices("INV-1001").map((d) => d.documentId)).toEqual([
      "a",
    ]);
  });

  it("finds it however the number is written", () => {
    const archive = archiveOf(parsed({ "@ID": "a", Reference: "#SBIE-1234" }));

    for (const asked of ["SBIE-1234", "sbie 1234", "#SBIE1234", "sbie.1234"]) {
      expect(archive.findInvoices(asked)).toHaveLength(1);
    }
  });

  it("answers with nothing for a number Yuki does not hold", () => {
    const archive = archiveOf(parsed({ Reference: "INV-1001" }));

    expect(archive.findInvoices("INV-9999")).toEqual([]);
  });

  it("does not let a bank statement answer for an invoice", () => {
    // Type 10 is a Rekeninguittreksel. It carries a Reference like everything
    // else, and on the measured archive 9 such references collided with a real
    // invoice number — so matching on the number alone would report that Yuki
    // already holds an invoice it has never seen, and the invoice would never
    // be sent.
    const archive = archiveOf(
      parsed({ "@ID": "statement", Type: "10", Reference: "INV-1001" }, 3),
    );

    expect(archive.findInvoices("INV-1001")).toEqual([]);
  });

  it("counts both a purchase and a sales invoice", () => {
    // A sales invoice in Verkoop is what stops Frederik's own invoice from
    // being uploaded back into Yuki as a purchase.
    const archive = archiveOf(
      parsed({ "@ID": "purchase", Type: "2", Reference: "INV-1001" }),
      parsed({ "@ID": "sale", Type: "6", Reference: "OUT-2002" }, 2),
    );

    expect(archive.findInvoices("OUT-2002").map((d) => d.documentId)).toEqual([
      "sale",
    ]);
  });

  it("answers with every invoice carrying the number, not just one", () => {
    const archive = archiveOf(
      parsed({ "@ID": "a", Reference: "INV-1001" }),
      parsed({ "@ID": "b", Reference: "inv 1001" }),
    );

    expect(archive.findInvoices("INV-1001").map((d) => d.documentId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("refuses a reference with nothing comparable in it", () => {
    // The one that matters: a reference of only punctuation normalises to the
    // empty string, and so does every unnumbered document in Yuki. Matching
    // them would answer "Yuki already has this" for all of them.
    const archive = archiveOf(
      parsed({ "@ID": "a", Reference: "###" }),
      parsed({ "@ID": "b", Reference: "" }),
      parsed({ "@ID": "c", Reference: "INV-1001" }),
    );

    for (const asked of ["", "   ", "###", "-"]) {
      expect(archive.findInvoices(asked)).toEqual([]);
    }
  });

  it("does not answer for a document Yuki has not classified as an invoice", () => {
    const archive = archiveOf(
      parsed({ "@ID": "unsorted", Type: "0", Reference: "INV-1001" }),
    );

    expect(archive.findInvoices("INV-1001")).toEqual([]);
  });

  it("keeps every document, invoice or not, for the callers that count them", () => {
    // The lookup filters; the archive itself does not. FF-1460 audits folder
    // counts, and FF-1450 pulls documents that are not invoices.
    const archive = archiveOf(
      parsed({ "@ID": "a", Type: "2" }),
      parsed({ "@ID": "b", Type: "10" }, 3),
    );

    expect(archive.documents).toHaveLength(2);
  });
});

describe("findDocuments", () => {
  it("finds what findInvoices will not, so the caller can refuse to decide", () => {
    // The live purchase folder holds 5 Type 0 "Standaard" documents, 3 of them
    // carrying a reference: a document that has arrived but has not been
    // classified as an invoice yet. Answering only "no invoice has this
    // number" would send it again, and Yuki cannot delete the duplicate.
    const archive = archiveOf(
      parsed({ "@ID": "unsorted", Type: "0", Reference: "INV-1001" }),
    );

    expect(archive.findInvoices("INV-1001")).toEqual([]);
    expect(archive.findDocuments("INV-1001").map((d) => d.documentId)).toEqual([
      "unsorted",
    ]);
  });

  it("finds invoices too, so the two answers can be compared", () => {
    const archive = archiveOf(
      parsed({ "@ID": "invoice", Type: "2", Reference: "INV-1001" }),
      parsed({ "@ID": "statement", Type: "10", Reference: "INV-1001" }, 3),
    );

    expect(archive.findDocuments("INV-1001").map((d) => d.documentId)).toEqual([
      "invoice",
      "statement",
    ]);
    expect(archive.findInvoices("INV-1001").map((d) => d.documentId)).toEqual([
      "invoice",
    ]);
  });

  it("says nothing at all for a number Yuki has never seen", () => {
    // The only answer that means "send it".
    const archive = archiveOf(parsed({ Reference: "INV-1001" }));

    expect(archive.findDocuments("INV-9999")).toEqual([]);
  });

  it("refuses a reference with nothing comparable in it, like findInvoices", () => {
    const archive = archiveOf(
      parsed({ "@ID": "a", Type: "0", Reference: "###" }),
    );

    expect(archive.findDocuments("###")).toEqual([]);
    expect(archive.findDocuments("")).toEqual([]);
  });
});

describe("readYukiArchive", () => {
  const folder = (id: number, description: string) => ({
    Description: description,
    ProcessedByYuki: "True",
    "@ID": String(id),
  });

  it("asks which folders exist, then reads each of them entire", async () => {
    const reader = fakeReader([
      {
        DocumentFolders: {
          DocumentFolder: [folder(1, "Aankoop"), folder(2, "Verkoop")],
        },
      },
      documents(document({ "@ID": "a", Reference: "INV-1001" })),
      documents(document({ "@ID": "b", Type: "6", Reference: "OUT-2002" })),
    ]);

    const archive = await readYukiArchive(reader);

    expect(archive.folders.map((f) => f.id)).toEqual([1, 2]);
    expect(archive.documents.map((d) => d.documentId)).toEqual(["a", "b"]);
    expect(reader.requests.map((r) => r.operation)).toEqual([
      "DocumentFolders",
      "ModifiedDocumentsInFolder",
      "ModifiedDocumentsInFolder",
    ]);
    expect(reader.requests.slice(1).map((r) => r.folderID)).toEqual([1, 2]);
  });

  it("reads folders the team made, not only the ones Yuki ships", async () => {
    // Folder 6 on the measured domain was a user folder, and user folders held
    // 44 documents. A read that assumed YUKI_FOLDERS would have missed them,
    // and a missed document is one that gets uploaded again.
    const reader = fakeReader([
      {
        DocumentFolders: {
          DocumentFolder: [
            { ...folder(118, "Vergunningen"), ProcessedByYuki: "False" },
          ],
        },
      },
      documents(document({ "@ID": "a" })),
    ]);

    const archive = await readYukiArchive(reader);

    expect(archive.folders).toEqual([
      { id: 118, description: "Vergunningen", processedByYuki: false },
    ]);
    expect(archive.documents).toHaveLength(1);
  });

  it("counts the calls it spent, the folder list included", async () => {
    const reader = fakeReader([
      { DocumentFolders: { DocumentFolder: folder(1, "Aankoop") } },
      documents(document({ "@ID": "a" }), document({ "@ID": "b" })),
      documents(document({ "@ID": "c" })),
    ]);

    const archive = await readYukiArchive(reader, { pageSize: 2 });

    expect(archive.calls).toBe(3);
  });

  it("stamps when it was read, because everything in it is exactly that old", async () => {
    const before = Date.now();
    const reader = fakeReader([
      { DocumentFolders: { DocumentFolder: folder(1, "Aankoop") } },
      { Documents: "" },
    ]);

    const archive = await readYukiArchive(reader);

    expect(archive.readAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
