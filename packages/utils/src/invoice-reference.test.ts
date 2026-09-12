import { describe, expect, it } from "bun:test";
import {
  isComparableInvoiceReference,
  normalizeInvoiceReference,
} from "./invoice-reference";

describe("normalizeInvoiceReference", () => {
  it("leaves a plain alphanumeric number alone, bar its case", () => {
    expect(normalizeInvoiceReference("263802037296")).toBe("263802037296");
    expect(normalizeInvoiceReference("INV001")).toBe("INV001");
  });

  it("collapses the prefix an invoice number is written with or without", () => {
    expect(normalizeInvoiceReference("#SBIE-1234")).toBe(
      normalizeInvoiceReference("SBIE-1234"),
    );
  });

  it("folds case, so one supplier's two spellings are one number", () => {
    // Both spellings of this one are in the archive.
    expect(normalizeInvoiceReference("c20601746442")).toBe(
      normalizeInvoiceReference("C20601746442"),
    );
  });

  it("removes the separators a number is grouped with", () => {
    expect(normalizeInvoiceReference("153/7933/96229")).toBe("153793396229");
    expect(normalizeInvoiceReference("900510.281.83")).toBe("90051028183");
    expect(normalizeInvoiceReference("2026 97975")).toBe("202697975");
    expect(normalizeInvoiceReference("\t2026-97975\n")).toBe("202697975");
  });

  it("keeps two genuinely different numbers different", () => {
    expect(normalizeInvoiceReference("INV-1")).not.toBe(
      normalizeInvoiceReference("INV-2"),
    );
    // Digits are not reordered or trimmed, so a prefix is not a match.
    expect(normalizeInvoiceReference("2026-979")).not.toBe(
      normalizeInvoiceReference("2026-97975"),
    );
  });

  it("does not fold letters that look alike", () => {
    // O and 0 are different characters, and guessing otherwise would merge
    // two suppliers' numbers.
    expect(normalizeInvoiceReference("INVO1")).not.toBe(
      normalizeInvoiceReference("INV01"),
    );
  });
});

describe("isComparableInvoiceReference", () => {
  it("accepts anything with a letter or a digit in it", () => {
    expect(isComparableInvoiceReference("1")).toBe(true);
    expect(isComparableInvoiceReference("#A")).toBe(true);
  });

  it("refuses a reference that normalises to nothing", () => {
    expect(isComparableInvoiceReference("")).toBe(false);
    expect(isComparableInvoiceReference("   ")).toBe(false);
    expect(isComparableInvoiceReference("-- / --")).toBe(false);
  });
});
