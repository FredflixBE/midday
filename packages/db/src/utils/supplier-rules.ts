/**
 * Which supplier a transaction's own text points at (FF-1555).
 *
 * Pure, so the database, the enrichment job and a rule preview all resolve a
 * transaction the same way. The rules themselves are in `supplier_rules`; see
 * the comment on that table for why a rule exists at all.
 */

export type SupplierRuleField =
  | "counterparty_iban"
  | "counterparty_name"
  | "name";

export type SupplierRuleForMatching = {
  id: string;
  /** Null for a rule that says this text names nobody. */
  supplierId: string | null;
  field: SupplierRuleField;
  /** Already normalised, as stored. */
  value: string;
};

export type TransactionForSupplierMatching = {
  name: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
};

export type SupplierMatch = {
  supplierId: string;
  ruleId: string;
};

/**
 * The fields in precedence order. A machine-issued account number is the
 * strongest evidence, the name the bank printed next, and the free text last.
 */
export const SUPPLIER_RULE_FIELDS: readonly SupplierRuleField[] = [
  "counterparty_iban",
  "counterparty_name",
  "name",
];

/**
 * A leading span shorter than this names nothing reliably: `xe` starts too
 * many things. Three characters still allows `vab`, `kbc`, `aws`.
 */
const MIN_SPAN_LENGTH = 3;

function normaliseText(value: string): string {
  return (
    value
      // Strip accents, so `Domiciliëring` and `Domiciliering` are one text: the
      // bank is consistent with itself, but a model quoting it may not be.
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The form a rule value is stored and compared in. Null when nothing is left.
 *
 * An IBAN is compared as the bank issues it — upper case, no spacing. Text is
 * lower-cased, unaccented and single-spaced, so the same words match however
 * they were typed.
 */
export function normaliseRuleValue(
  field: SupplierRuleField,
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;

  const value =
    field === "counterparty_iban"
      ? raw.replace(/\s+/g, "").toUpperCase()
      : normaliseText(raw);

  return value.length > 0 ? value : null;
}

/** A supplier name as stored: trimmed and single-spaced, casing kept. */
export function normaliseSupplierName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** `text` starts with `span`, and the span ends where a word does. */
function startsWithSpan(text: string, span: string): boolean {
  return text === span || text.startsWith(`${span} `);
}

/** Does this rule match this transaction? Values are compared normalised. */
export function ruleMatches(
  rule: Pick<SupplierRuleForMatching, "field" | "value">,
  transaction: TransactionForSupplierMatching,
): boolean {
  switch (rule.field) {
    case "counterparty_iban":
      return (
        normaliseRuleValue(
          "counterparty_iban",
          transaction.counterpartyIban,
        ) === rule.value
      );
    case "counterparty_name":
      return (
        normaliseRuleValue(
          "counterparty_name",
          transaction.counterpartyName,
        ) === rule.value
      );
    case "name": {
      const name = normaliseRuleValue("name", transaction.name);
      return name !== null && startsWithSpan(name, rule.value);
    }
  }
}

/**
 * The supplier the rules give this transaction, and the rule that gave it.
 * Null when no rule answers.
 *
 * **Precedence is stated, never left to insertion order** — otherwise the
 * answer would depend on which rule happened to be saved first. The field
 * decides first (see `SUPPLIER_RULE_FIELDS`), and within the text the longest
 * matching span wins: `sumup kimakh wahib` is more specific than `sumup`.
 * Within an exact field only one rule can match, because the value is unique
 * per team.
 *
 * A matching rule with no supplier says the text names nobody — the
 * accountant's collective `Diverse leveranciers Restaurant` — so that field is
 * passed over and the next one is read. On the text, the last field, it means
 * no answer.
 */
export function resolveSupplier(
  rules: readonly SupplierRuleForMatching[],
  transaction: TransactionForSupplierMatching,
): SupplierMatch | null {
  for (const field of SUPPLIER_RULE_FIELDS) {
    const best = rules
      .filter((rule) => rule.field === field && ruleMatches(rule, transaction))
      .sort(
        (a, b) =>
          b.value.length - a.value.length || a.value.localeCompare(b.value),
      )[0];

    if (!best) continue;

    if (best.supplierId) {
      return { supplierId: best.supplierId, ruleId: best.id };
    }
  }

  return null;
}

/**
 * The rule value for a span the model says names the supplier, or null when
 * the span cannot be kept as a rule.
 *
 * The model is asked which **leading** part of the text is the supplier — `the
 * span before "Betaling Met"` — and its answer is only kept when the text
 * really starts with it, ends on a word boundary, and is long enough to mean
 * something. Anything else is refused rather than repaired: a span from the
 * middle of the text is exactly the "contains KBC" rule this design exists to
 * prevent.
 *
 * The whole text is refused too. Card text carries a reference that changes on
 * every payment, so a rule as long as the text would match this one payment
 * and nothing after it — one rule per transaction, which is the cost this is
 * meant to remove.
 */
export function leadingSpanRule(
  name: string,
  span: string | null,
): string | null {
  const text = normaliseRuleValue("name", name);
  const value = normaliseRuleValue("name", span);

  if (!text || !value) return null;
  if (value.length < MIN_SPAN_LENGTH) return null;
  if (value === text) return null;

  return startsWithSpan(text, value) ? value : null;
}
