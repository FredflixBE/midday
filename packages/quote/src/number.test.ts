import { describe, expect, test } from "bun:test";
import {
  formatQuoteVersion,
  nextQuoteNumber,
  quoteNumberSequence,
} from "./number";

describe("quote numbers", () => {
  test("the first quote is 0001 under the team's prefix", () => {
    expect(nextQuoteNumber("OFF-", null)).toBe("OFF-0001");
  });

  test("the next one follows the highest in use", () => {
    expect(nextQuoteNumber("OFF-", 41)).toBe("OFF-0042");
    expect(nextQuoteNumber("OFF-", 9999)).toBe("OFF-10000");
  });

  test("the sequence is read from the trailing digits", () => {
    expect(quoteNumberSequence("OFF-0042")).toBe(42);
    expect(quoteNumberSequence("Q2026-007")).toBe(7);
    expect(quoteNumberSequence("DRAFT")).toBeNull();
  });

  test("the first version shows the number alone, later ones their version", () => {
    expect(formatQuoteVersion("OFF-0001", 1)).toBe("OFF-0001");
    expect(formatQuoteVersion("OFF-0001", 2)).toBe("OFF-0001 v2");
  });
});
