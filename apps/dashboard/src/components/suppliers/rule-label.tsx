/**
 * A supplier rule said the way a person reads it (FF-1555). Shared by the
 * transaction sheet, which says which rule matched, and the suppliers page.
 */
export type SupplierRuleField =
  | "counterparty_iban"
  | "counterparty_name"
  | "name";

export const RULE_FIELD_LABELS: Record<SupplierRuleField, string> = {
  counterparty_iban: "Account (IBAN) is",
  counterparty_name: "Counterparty is",
  name: "Description starts with",
};

export function RuleLabel({
  field,
  value,
}: {
  field: SupplierRuleField;
  value: string;
}) {
  return (
    <span>
      {RULE_FIELD_LABELS[field]}{" "}
      <span className="font-mono text-foreground">{value}</span>
    </span>
  );
}
