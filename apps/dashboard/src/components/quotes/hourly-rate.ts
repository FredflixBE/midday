import { rateInUnit, type UnitSettings } from "@midday/quote";

/**
 * How an hourly rate reads: the currency's symbol before the number and
 * "/h" after it, e.g. €100/h. The symbol comes from the currency code, so a
 * USD team sees $ without anything being hard-coded.
 */
export function currencySymbol(currency: string) {
  try {
    return (
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/** Prefix and suffix for a rate input. */
export function hourlyRateAffixes(currency: string) {
  return { prefix: currencySymbol(currency), suffix: "/h" };
}

export function formatHourlyRate(rate: number, currency: string) {
  const amount = Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
  return `${currencySymbol(currency)}${amount}/h`;
}

/** An hourly rate as the quote shows it: €100/h, or €800/day in days. */
export function formatUnitRate(
  rate: number,
  currency: string,
  unit: UnitSettings,
) {
  if (unit.displayUnit === "hours") return formatHourlyRate(rate, currency);
  const day = rateInUnit(Math.round(rate * 100), unit) / 100;
  const amount = Number.isInteger(day) ? String(day) : day.toFixed(2);
  return `${currencySymbol(currency)}${amount}/day`;
}
