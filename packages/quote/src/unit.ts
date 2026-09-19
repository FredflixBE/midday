import type { QuoteContent } from "./content";
import type { Amount } from "./pricing";

/**
 * Hours or days (FF-1619, docs/quotes.md §3.1). A quote is always stored and
 * priced in hours; a quote shown in days reads and takes its quantities as
 * days of the quote's own hours per day, and its rates as day rates.
 */
export type UnitSettings = Pick<QuoteContent, "displayUnit" | "hoursPerDay">;

const toHundredth = (value: number) => Math.round(value * 100) / 100;

/** Stored hours as the quote shows them: days to the hundredth, or hours. */
export function hoursToUnit(hours: number, unit: UnitSettings) {
  return unit.displayUnit === "days"
    ? toHundredth(hours / unit.hoursPerDay)
    : hours;
}

/**
 * A quantity typed in the quote's unit, as the hours to store. Days become
 * hours to the hundredth, which shows back as the days typed.
 */
export function unitToHours(value: number, unit: UnitSettings) {
  return unit.displayUnit === "days"
    ? toHundredth(value * unit.hoursPerDay)
    : value;
}

export function amountInUnit(value: Amount, unit: UnitSettings): Amount {
  return {
    amount: hoursToUnit(value.amount, unit),
    max: value.max === null ? null : hoursToUnit(value.max, unit),
  };
}

/** An hourly rate in cents as the rate per unit: a day rate, in days. */
export function rateInUnit(hourlyCents: number, unit: UnitSettings) {
  return unit.displayUnit === "days"
    ? Math.round(hourlyCents * unit.hoursPerDay)
    : hourlyCents;
}
