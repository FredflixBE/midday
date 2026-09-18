/**
 * Seam under test: which supplier a transaction's own text points at, given a
 * team's stored rules (FF-1555). Pure — no database.
 *
 * The strings are shaped like the live bank text, because the dangers are in
 * that shape: every debit-card payment carries the card issuer's name in its
 * boilerplate, so a rule that matched anywhere would hand all of them to it.
 */
import { describe, expect, test } from "bun:test";
import {
  leadingSpanRule,
  normaliseRuleValue,
  normaliseSupplierName,
  resolveSupplier,
  type SupplierRuleForMatching,
  type TransactionForSupplierMatching,
} from "./supplier-rules";

const XERIUS_CARD =
  "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart Via Bancontact 28 12 2025 Om 15 56 Uur";

function tx(
  overrides: Partial<TransactionForSupplierMatching> = {},
): TransactionForSupplierMatching {
  return {
    name: "Payment",
    counterpartyName: null,
    counterpartyIban: null,
    ...overrides,
  };
}

function rule(
  overrides: Partial<SupplierRuleForMatching> &
    Pick<SupplierRuleForMatching, "field" | "value">,
): SupplierRuleForMatching {
  return {
    id: `rule-${overrides.field}-${overrides.value}`,
    supplierId: `supplier-${overrides.value}`,
    ...overrides,
  };
}

describe("normaliseRuleValue", () => {
  test("an IBAN loses its spacing and its case", () => {
    expect(
      normaliseRuleValue("counterparty_iban", " be82 4100 0144 0168"),
    ).toBe("BE82410001440168");
  });

  test("text is lower-cased, unaccented and single-spaced", () => {
    expect(normaliseRuleValue("name", "  Telenet  Bv Domiciliëring ")).toBe(
      "telenet bv domiciliering",
    );
    expect(normaliseRuleValue("counterparty_name", "Kbc  Verzekeringen")).toBe(
      "kbc verzekeringen",
    );
  });

  test("nothing left is no value at all", () => {
    expect(normaliseRuleValue("name", "   ")).toBeNull();
    expect(normaliseRuleValue("counterparty_iban", null)).toBeNull();
  });
});

describe("resolveSupplier", () => {
  test("a name rule matches a leading span, not a substring anywhere", () => {
    const rules = [rule({ field: "name", value: "kbc" })];

    // The card issuer is in the boilerplate of the Xerius payment. A rule that
    // matched anywhere would make this KBC's.
    expect(resolveSupplier(rules, tx({ name: XERIUS_CARD }))).toBeNull();
    expect(
      resolveSupplier(rules, tx({ name: "Kbc Mastercard Afrekening 174" })),
    ).toMatchObject({ supplierId: "supplier-kbc" });
  });

  test("a leading span stops at a word boundary", () => {
    const rules = [rule({ field: "name", value: "vab" })];

    expect(
      resolveSupplier(rules, tx({ name: "Vabali Spa Berlin" })),
    ).toBeNull();
    expect(
      resolveSupplier(rules, tx({ name: "Vab Nv Domiciliering 7" })),
    ).toMatchObject({ supplierId: "supplier-vab" });
  });

  test("the longest matching span wins, whatever order the rules came in", () => {
    const short = rule({ field: "name", value: "sumup" });
    const long = rule({ field: "name", value: "sumup kimakh wahib" });
    const payment = tx({ name: "SumUp KIMAKH WAHIB Paris FRA" });

    expect(resolveSupplier([short, long], payment)?.ruleId).toBe(long.id);
    expect(resolveSupplier([long, short], payment)?.ruleId).toBe(long.id);
  });

  test("an IBAN outranks a counterparty name, which outranks the text", () => {
    const byIban = rule({
      field: "counterparty_iban",
      value: "BE82410001440168",
    });
    const byCounterparty = rule({
      field: "counterparty_name",
      value: "sd worx sociaal secretariaat vzw",
    });
    const byName = rule({ field: "name", value: "sd worx" });
    const payment = tx({
      name: "Sd Worx Sociaal Secretariaat Vzw Overschrijving",
      counterpartyName: "Sd Worx Sociaal Secretariaat Vzw",
      counterpartyIban: "BE82 4100 0144 0168",
    });

    expect(
      resolveSupplier([byName, byCounterparty, byIban], payment)?.ruleId,
    ).toBe(byIban.id);
    expect(resolveSupplier([byName, byCounterparty], payment)?.ruleId).toBe(
      byCounterparty.id,
    );
    expect(resolveSupplier([byName], payment)?.ruleId).toBe(byName.id);
  });

  test("a counterparty name matches whole, not as a prefix", () => {
    const rules = [
      rule({ field: "counterparty_name", value: "kbc verzekeringen" }),
    ];

    expect(
      resolveSupplier(rules, tx({ counterpartyName: "Kbc Verzekeringen Nv" })),
    ).toBeNull();
    expect(
      resolveSupplier(rules, tx({ counterpartyName: "KBC Verzekeringen" })),
    ).toMatchObject({ supplierId: "supplier-kbc verzekeringen" });
  });

  test("a collective name says nobody, and the text is read instead", () => {
    const collective = rule({
      field: "counterparty_name",
      value: "diverse leveranciers restaurant",
      supplierId: null,
    });
    const merchant = rule({ field: "name", value: "le quai son" });

    expect(
      resolveSupplier(
        [collective, merchant],
        tx({
          name: "Le Quai Son Antwerpen BEL",
          counterpartyName: "Diverse leveranciers Restaurant",
        }),
      ),
    ).toMatchObject({ supplierId: "supplier-le quai son" });

    expect(
      resolveSupplier(
        [collective],
        tx({
          name: "Somewhere Else",
          counterpartyName: "Diverse leveranciers Restaurant",
        }),
      ),
    ).toBeNull();
  });
});

describe("leadingSpanRule", () => {
  test("keeps a span the text actually starts with", () => {
    expect(leadingSpanRule(XERIUS_CARD, "Xerius Be2000 Antwerpen")).toBe(
      "xerius be2000 antwerpen",
    );
  });

  test("refuses a span from the middle of the text", () => {
    // What the model must not be allowed to store: this is the card issuer.
    expect(leadingSpanRule(XERIUS_CARD, "Kbc Debetkaart")).toBeNull();
  });

  test("refuses a span that ends inside a word, or is too short to mean anything", () => {
    expect(leadingSpanRule(XERIUS_CARD, "Xeri")).toBeNull();
    expect(leadingSpanRule("Xe Something", "Xe")).toBeNull();
  });

  test("refuses the whole text, which would only ever match itself", () => {
    // Card text carries a reference that changes every payment; a span as long
    // as the text is not a rule, it is one transaction.
    expect(
      leadingSpanRule("LinkedIn P3042704055", "LinkedIn P3042704055"),
    ).toBeNull();
  });
});

describe("normaliseSupplierName", () => {
  test("trims and collapses whitespace but keeps the casing a person chose", () => {
    expect(normaliseSupplierName("  KBC   Verzekeringen NV ")).toBe(
      "KBC Verzekeringen NV",
    );
  });
});
