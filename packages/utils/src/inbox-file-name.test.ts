import { describe, expect, test } from "bun:test";
import { inboxFileName } from "./inbox-file-name";
import { stripSpecialCharacters } from "./index";

describe("the name a document is stored under in the inbox", () => {
  test("differs for two uploads of the same file name", () => {
    const first = inboxFileName({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });
    const second = inboxFileName({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^invoice_[0-9a-f]{8}\.pdf$/);
    expect(second).toMatch(/^invoice_[0-9a-f]{8}\.pdf$/);
  });

  test("repeats when the caller has something stable to key on", () => {
    const name = () =>
      inboxFileName({
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        suffix: "F09ABCDEF",
      });

    expect(name()).toBe("invoice_F09ABCDEF.pdf");
    expect(name()).toBe(name());
  });

  test("is one Storage accepts, whatever the document was called", () => {
    // Storage refuses a key outside ASCII letters, digits and a short list of
    // punctuation; "Fréderik" stopped a live Gmail backfill.
    const name = (filename: string) =>
      inboxFileName({
        filename,
        mimeType: "application/pdf",
        suffix: "abc123",
      });

    expect(name("Rechnung Müller & Söhne #42 [März].pdf")).toBe(
      "Rechnung Muller & Sohne _42 _Marz__abc123.pdf",
    );
    expect(name("発票.pdf")).toBe("___abc123.pdf");
  });

  test("is one path segment, so a slash in the name makes no folder", () => {
    expect(
      inboxFileName({
        filename: "2026/09 invoice.pdf",
        mimeType: "application/pdf",
        suffix: "abc123",
      }),
    ).toBe("2026_09 invoice_abc123.pdf");
  });

  test("gains its extension when the document arrived without one", () => {
    expect(
      inboxFileName({
        filename: "factuur",
        mimeType: "application/pdf",
        suffix: "abc123",
      }),
    ).toBe("factuur_abc123.pdf");
    expect(
      inboxFileName({ filename: "scan", mimeType: "image/png", suffix: "a1" }),
    ).toBe("scan_a1.png");
  });

  test("survives the dashboard uploader's own stripping untouched", () => {
    // The dashboard registers the inbox item under this name and then uploads
    // the file, and `resumableUpload` strips the name it is given a second
    // time. If that changed anything, the item would point at a path no file
    // was ever written to.
    for (const filename of [
      "My Invoice (final).pdf",
      "Rechnung Müller.pdf",
      "発票",
      "receipt",
    ]) {
      const stored = inboxFileName({
        filename: stripSpecialCharacters(filename),
        mimeType: "application/pdf",
      });

      expect(stripSpecialCharacters(stored)).toBe(stored);
    }
  });
});
