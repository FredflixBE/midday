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
