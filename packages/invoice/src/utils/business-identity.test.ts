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

/** The lines of the block, in order, as someone reading the PDF sees them. */
const lines = (identity: BusinessIdentity) =>
  (businessIdentityDoc(identity)?.content ?? []).map((node) =>
    (node.content ?? []).map((child) => child.text ?? "").join(""),
  );

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
      "Ondernemingsnummer 0123.456.789",
      "RPR Antwerpen, afdeling Antwerpen",
      "IBAN BE68 5390 0754 7034",
      "BIC GKCCBEBB",
    ]);
  });

  test("leaves out a line nothing was said for", () => {
    expect(
      lines({ legalName: "Fredflix", enterpriseNumber: "0123.456.789" }),
    ).toEqual(["Fredflix", "Ondernemingsnummer 0123.456.789"]);
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
