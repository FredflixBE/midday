import { describe, expect, test } from "bun:test";
import { comparableInvoiceReference } from "./invoice-reference";

describe("comparableInvoiceReference", () => {
  test("leaves a plain alphanumeric number alone, bar its case", () => {
    expect(comparableInvoiceReference("263802037296")).toBe("263802037296");
    expect(comparableInvoiceReference("INV001")).toBe("INV001");
  });

  test("collapses the prefix an invoice number is written with or without", () => {
    expect(comparableInvoiceReference("#SBIE-1234")).toBe(
      comparableInvoiceReference("SBIE-1234"),
    );
  });

  test("folds case, so one supplier's two spellings are one number", () => {
    // Both spellings of this one are in the archive.
    expect(comparableInvoiceReference("c20601746442")).toBe(
      comparableInvoiceReference("C20601746442"),
    );
  });

  test("removes the separators a number is grouped with", () => {
    expect(comparableInvoiceReference("153/7933/96229")).toBe("153793396229");
    expect(comparableInvoiceReference("900510.281.83")).toBe("90051028183");
    expect(comparableInvoiceReference("2026 97975")).toBe("202697975");
    expect(comparableInvoiceReference("\t2026-97975\n")).toBe("202697975");
  });

  test("keeps two genuinely different numbers different", () => {
    expect(comparableInvoiceReference("INV-1")).not.toBe(
      comparableInvoiceReference("INV-2"),
    );
    // Digits are not reordered or trimmed, so a prefix is not a match.
    expect(comparableInvoiceReference("2026-979")).not.toBe(
      comparableInvoiceReference("2026-97975"),
    );
  });

  test("does not fold letters that look alike", () => {
    // O and 0 are different characters, and guessing otherwise would merge
    // two suppliers' numbers.
    expect(comparableInvoiceReference("INVO1")).not.toBe(
      comparableInvoiceReference("INV01"),
    );
  });

  test("keeps an accented letter rather than folding it into another number", () => {
    // Stripping it would make "INVE1" and "INVÉ1" the same number. No
    // reference in the measured archive has one, which is why this is a guard
    // rather than an observation.
    expect(comparableInvoiceReference("INVÉ1")).not.toBe(
      comparableInvoiceReference("INVE1"),
    );
    expect(comparableInvoiceReference("Nº-2026")).toBe("Nº2026");
  });

  test("answers null for a reference with nothing to compare in it", () => {
    // Not "": an empty string matches every other empty string, and 900 of the
    // archive's 1,815 documents have no reference at all.
    expect(comparableInvoiceReference("")).toBeNull();
    expect(comparableInvoiceReference("   ")).toBeNull();
    expect(comparableInvoiceReference("-- / --")).toBeNull();
  });

  test("accepts anything with a single letter or digit in it", () => {
    expect(comparableInvoiceReference("1")).toBe("1");
    expect(comparableInvoiceReference("#A")).toBe("A");
  });
});
