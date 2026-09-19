import type { Amount, WorkTypeRates } from "@midday/quote";
import { formatAmount } from "@/utils/format";

/**
 * The rates a quote is priced with in the editor (FF-1611): every work
 * type's default, archived ones included so older lines still price, and the
 * customer's own. The quote's own overrides are in its content.
 */
export function toWorkTypeRates(
  workTypes: { id: string; hourlyRate: number }[] | undefined,
  customerRates: { workTypeId: string; hourlyRate: number }[] | undefined,
): WorkTypeRates {
  return {
    defaults: Object.fromEntries(
      (workTypes ?? []).map((w) => [w.id, w.hourlyRate]),
    ),
    customer: Object.fromEntries(
      (customerRates ?? []).map((r) => [r.workTypeId, r.hourlyRate]),
    ),
  };
}

function money(cents: number, currency: string, locale?: string) {
  const whole = cents % 100 === 0;
  return (
    formatAmount({
      amount: cents / 100,
      currency,
      locale,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }) ?? ""
  );
}

/** An amount in cents, or a range of them as `€1,000 – €1,500`. */
export function formatQuoteAmount(
  value: Amount,
  currency: string,
  locale?: string,
) {
  const low = money(value.amount, currency, locale);
  if (value.max === null || value.max === value.amount) return low;
  return `${low} – ${money(value.max, currency, locale)}`;
}
