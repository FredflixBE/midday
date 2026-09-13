import { TZDate } from "@date-fns/tz";
import {
  differenceInDays,
  differenceInMonths,
  format,
  startOfDay,
} from "date-fns";
import { normalizeCurrencyCode } from "./currency";

export function formatSize(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

  const unitIndex = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  );

  return Intl.NumberFormat("en-US", {
    style: "unit",
    unit: units[unitIndex],
  }).format(+Math.round(bytes / 1024 ** unitIndex));
}

type FormatAmountParams = {
  currency: string;
  amount: number;
  locale?: string | null;
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
};

export function formatAmount({
  currency,
  amount,
  locale = "en-US",
  minimumFractionDigits,
  maximumFractionDigits,
}: FormatAmountParams) {
  if (!currency) {
    return;
  }

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const safeLocale = locale ?? undefined;

  const formatDecimal = () =>
    Intl.NumberFormat(safeLocale, {
      style: "decimal",
      minimumFractionDigits: minimumFractionDigits ?? 2,
      maximumFractionDigits: maximumFractionDigits ?? 2,
    }).format(safeAmount);

  if (currency.toUpperCase() === "XXX") {
    return formatDecimal();
  }

  const normalizedCurrency = normalizeCurrencyCode(currency);

  try {
    return Intl.NumberFormat(safeLocale, {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(safeAmount);
  } catch {
    return formatDecimal();
  }
}

export function secondsToHoursAndMinutes(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }

  if (hours) {
    return `${hours}h`;
  }

  if (minutes) {
    return `${minutes}m`;
  }

  return "0m";
}

type BurnRateData = {
  value: number;
  date: string;
};

export function calculateAvgBurnRate(data: BurnRateData[] | null) {
  if (!data) {
    return 0;
  }

  return data?.reduce((acc, curr) => acc + curr.value, 0) / data?.length;
}

export function formatAccountName({
  name = "",
  currency,
}: {
  name?: string;
  currency?: string | null;
}) {
  if (currency) {
    return `${name} (${currency})`;
  }

  return name;
}

export function formatDateRange(dates: TZDate[]): string {
  if (!dates.length) return "";

  const formatFullDate = (date: TZDate) => format(date, "MMM d");
  const formatDay = (date: TZDate) => format(date, "d");

  const startDate = dates[0];
  const endDate = dates[1];

  if (!startDate) return "";

  if (
    dates.length === 1 ||
    !endDate ||
    startDate.getTime() === endDate.getTime()
  ) {
    return formatFullDate(startDate);
  }

  if (startDate.getMonth() === endDate.getMonth()) {
    // Same month
    return `${format(startDate, "MMM")} ${formatDay(startDate)} - ${formatDay(endDate)}`;
  }
  // Different months
  return `${formatFullDate(startDate)} - ${formatFullDate(endDate)}`;
}

export function getDueDateStatus(dueDate: string): string {
  // Parse due date as UTC (it's stored as UTC midnight)
  const due = new TZDate(dueDate, "UTC");

  // Get current date in UTC for consistent comparison
  const now = new Date();
  const nowUTC = new TZDate(now.toISOString(), "UTC");

  // Compare at the day level in UTC
  const nowDay = startOfDay(nowUTC);
  const dueDay = startOfDay(due);

  const diffDays = differenceInDays(dueDay, nowDay);
  const diffMonths = differenceInMonths(dueDay, nowDay);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";

  if (diffDays > 0) {
    if (diffMonths < 1) return `in ${diffDays} days`;
    return `in ${diffMonths} month${diffMonths === 1 ? "" : "s"}`;
  }

  if (diffMonths < 1)
    return `${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? "" : "s"} ago`;
  return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;
}

export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return "just now";
  }

  const intervals = [
    { label: "y", seconds: 31536000 },
    { label: "mo", seconds: 2592000 },
    { label: "d", seconds: 86400 },
    { label: "h", seconds: 3600 },
    { label: "m", seconds: 60 },
  ] as const;

  for (const interval of intervals) {
    const count = Math.floor(diffInSeconds / interval.seconds);
    if (count > 0) {
      return `${count}${interval.label} ago`;
    }
  }

  return "just now";
}

export function formatCompactAmount(
  amount: number,
  locale?: string | null,
): string {
  const absAmount = Math.abs(amount);
  const safeLocale = locale ?? "en-US";

  if (absAmount >= 1000000) {
    const formatted = (absAmount / 1000000).toLocaleString(safeLocale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return `${formatted}m`;
  }
  // Always show in thousands notation
  const formatted = (absAmount / 1000).toLocaleString(safeLocale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatted}k`;
}

type ConversionParams = {
  /** The amount as billed, in `originalCurrency`. */
  originalAmount: number | null;
  /** The currency the charge was actually made in. */
  originalCurrency: string | null;
  /** The currency the charge was settled in. */
  currency: string;
  locale?: string | null;
};

/**
 * What a foreign-currency charge originally cost, in words (FF-1560).
 *
 * One fact: the amount the supplier billed, in the currency they billed it in,
 * formatted to the reader's locale. It sits under the euro that actually left
 * the account, and together they are the whole story — $19.95 was asked for,
 * €17.57 was taken.
 *
 * **No exchange rate.** The first version showed one and Frederik's verdict on
 * reading it against the real books was that it "doesn't add any meaningful
 * information". He is right, and it was worse than useless: the rate came from
 * the accountant's ledger and is a coarse periodic figure, so it does not
 * reconcile with the two amounts printed beside it. Measured over the 62 live
 * foreign charges — five distinct stated rates against true rates spanning
 * 1.12045 to 1.16961, and only 3 of 62 reconciling, the worst out by €1.04. A
 * number that invites a person to check it and then fails the check is a defect,
 * and the rate is recoverable exactly by dividing the two amounts anyway.
 *
 * Returns null when there is nothing to describe, which is most transactions.
 */
export function formatConversion({
  originalAmount,
  originalCurrency,
  currency,
  locale,
}: ConversionParams): string | null {
  if (originalAmount == null || !originalCurrency) return null;

  // A charge in the currency it was settled in is not a conversion, so there is
  // nothing to say that the amount above does not already say.
  if (originalCurrency === currency) return null;

  const original = formatAmount({
    amount: originalAmount,
    currency: originalCurrency,
    locale,
    maximumFractionDigits: 2,
  });

  return original ? `Originally ${original}` : null;
}
