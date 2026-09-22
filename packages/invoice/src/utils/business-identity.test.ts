import { describe, expect, test } from "bun:test";
import {
  type BusinessIdentity,
  businessIdentityDoc,
  hasBusinessIdentity,
} from "./business-identity";

const FULL: BusinessIdentity = {
  legalName: "Fredflix",
  legalForm: "BV",
  addressLine1: "Voorbeeldstraat 1",
  addressLine2: "bus 3",
  zip: "2000",
  city: "Antwerpen",
  countryCode: "BE",
  enterpriseNumber: "0123.456.789",
  rprCourt: "Antwerpen, afdeling Antwerpen",
  bankIban: "BE68 5390 0754 7034",
  bankBic: "GKCCBEBB",
};

/**
 * The lines of the block, in order, as someone reading the PDF sees them.
 * It is one paragraph broken by `hardBreak`, not a paragraph each (FF-1677).
 */
const lines = (identity: BusinessIdentity) => {
  const doc = businessIdentityDoc(identity);
  if (!doc) return [];
  const read: string[] = [""];
  for (const node of doc.content?.[0]?.content ?? []) {
    if (node.type === "hardBreak") read.push("");
    else read[read.length - 1] += node.text ?? "";
  }
  return read;
};

describe("businessIdentityDoc", () => {
  // WVV art. 2:20 asks for the name, legal form, registered office,
  // enterprise number and the court of the RPR; WER art. III.25 for a bank
  // account. All of it on one block, which is what a quote's Van shows.
  test("states everything the law asks for", () => {
    expect(lines(FULL)).toEqual([
      "Fredflix BV",
      "Voorbeeldstraat 1",
      "bus 3",
      "2000 Antwerpen",
      "0123.456.789",
      "RPR Antwerpen, afdeling Antwerpen",
      "IBAN BE68 5390 0754 7034",
      "BIC GKCCBEBB",
    ]);
  });

  test("leaves out a line nothing was said for", () => {
    expect(
      lines({ legalName: "Fredflix", enterpriseNumber: "0123.456.789" }),
    ).toEqual(["Fredflix", "0123.456.789"]);
  });

  test("puts the postcode and the town on one line, either alone", () => {
    expect(lines({ legalName: "X", zip: "2000" })).toEqual(["X", "2000"]);
    expect(lines({ legalName: "X", city: "Antwerpen" })).toEqual([
      "X",
      "Antwerpen",
    ]);
  });

  test("passes over blank and whitespace-only fields", () => {
    expect(
      lines({ legalName: " Fredflix ", legalForm: "  ", city: "" }),
    ).toEqual(["Fredflix"]);
  });

  // The customer block beside it says "Belgium"; a raw "BE" there read as a
  // defect, and the country is not among the things WVV art. 2:20 asks for.
  test("does not print the country code", () => {
    expect(lines({ legalName: "X", countryCode: "BE" })).toEqual(["X"]);
  });

  // An address is one thing said on several lines. A paragraph each gave
  // every line paragraph spacing, which made the tightest block on the page
  // the loosest (FF-1677).
  test("is one paragraph, its lines separated by breaks", () => {
    const doc = businessIdentityDoc(FULL);
    expect(doc?.content).toHaveLength(1);
    const kinds = (doc?.content?.[0]?.content ?? []).map((n) => n.type);
    expect(new Set(kinds)).toEqual(new Set(["text", "hardBreak"]));
    // eight lines, so seven breaks between them
    expect(kinds.filter((k) => k === "hardBreak")).toHaveLength(7);
  });

  test("is null when nothing at all has been said", () => {
    expect(businessIdentityDoc({})).toBeNull();
    expect(businessIdentityDoc({ legalName: "   ", bankIban: "" })).toBeNull();
  });
});

describe("hasBusinessIdentity", () => {
  test("is true once any one field is filled in", () => {
    expect(hasBusinessIdentity({ bankIban: "BE68" })).toBe(true);
    expect(hasBusinessIdentity(FULL)).toBe(true);
  });

  test("is false for an empty one, so the old From box still wins", () => {
    expect(hasBusinessIdentity({})).toBe(false);
    expect(hasBusinessIdentity({ legalName: "  ", city: null })).toBe(false);
  });
});
