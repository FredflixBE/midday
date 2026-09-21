/**
 * Shared utilities for chart styling and data formatting
 */

import { format, parseISO } from "date-fns";

// Tailwind classes for chart styling
export const chartClasses = {
  container: "w-full h-full",
  tooltip: {
    light: "bg-white border border-gray-200 rounded-none shadow-sm",
    dark: "bg-[#0c0c0c] border border-[#1d1d1d] rounded-none shadow-sm",
  },
  text: {
    light: "fill-gray-500",
    dark: "fill-gray-400",
  },
} as const;

// Common chart configurations
export const commonChartConfig = {
  margin: { top: 6, right: 20, left: 0, bottom: 6 },
  fontFamily: "var(--font-hedvig-sans)",
  fontSize: 10,
  animationDuration: 300,
} as const;

// Utility functions
export const formatPercentage = (value: number): string => {
  return `${value.toFixed(1)}%`;
};

export const formatNumber = (value: number): string => {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(0)}k`;
  }
  return value.toString();
};

// Compact tick formatter for charts (600k, 1.2M, etc.)
export const createCompactTickFormatter = () => {
  return (value: number): string => {
    const absValue = Math.abs(value);
    const sign = value < 0 ? "-" : "";

    if (absValue >= 1000000) {
      return `${sign}${(absValue / 1000000).toFixed(1)}M`;
    }
    if (absValue >= 1000) {
      return `${sign}${(absValue / 1000).toFixed(0)}k`;
    }
    // Rounded, not raw: an axis label reading "32.89" is a bug, not precision.
    return Math.round(value).toString();
  };
};

// Currency-aware Y-axis tick formatter (e.g., "14k", "16k") - no currency symbol
export const createYAxisTickFormatter = (
  _currency: string,
  _locale?: string,
) => {
  return (value: number): string => {
    const absValue = Math.abs(value);
    const sign = value < 0 ? "-" : "";

    if (absValue >= 1000000) {
      return `${sign}${(absValue / 1000000).toFixed(1)}M`;
    }
    if (absValue >= 1000) {
      return `${sign}${(absValue / 1000).toFixed(0)}k`;
    }
    return value.toString();
  };
};

// Formatter for runway months (e.g., "10.5mo", "8.2mo", "0.0mo")
export const createMonthsTickFormatter = () => {
  return (value: number): string => {
    // Handle edge cases
    if (!Number.isFinite(value)) return "0.0mo";
    if (value === 0) return "0.0mo";
    return `${value.toFixed(1)}mo`;
  };
};

/**
 * Rounds a rough step up to the nearest 1, 2 or 5 times a power of ten.
 *
 * 2.5 is deliberately not in the set. A step of 2500 puts a tick at 2500,
 * which the compact formatter prints as "3k" — a label that lies.
 */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * A y-axis that always includes zero and always lands on round numbers.
 *
 * Recharts rounds ticks for you, but only while it owns the domain. Passing
 * it a domain — and a function domain especially — turns that off, and the
 * ticks become evenly-spaced raw values: the midpoint of a range running
 * from -12,760 to 12,826 is 32.89, and that is what the axis then says.
 *
 * So the ticks are computed here instead. Every tick is a multiple of the
 * step, which makes zero one of them, which puts a gridline exactly where
 * the bars turn over.
 *
 * Use this for charts whose values can go negative (profit, cash flow,
 * growth rate).
 */
export function getZeroInclusiveAxis(
  values: number[],
  // Seven, not Recharts' five. Rounding outwards to a nice step costs height,
  // and with only four intervals the step has to jump so far that the tallest
  // bar can end up filling half the plot. Six intervals keeps the padding
  // small while the labels stay comfortably apart on a 320px chart.
  tickCount = 7,
): { domain: [number, number]; ticks: number[] } {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = Math.min(0, ...finite);
  const max = Math.max(0, ...finite);

  if (min === 0 && max === 0) return { domain: [0, 1], ticks: [0, 1] };

  const intervals = Math.max(1, tickCount - 1);
  let step = niceStep((max - min) / intervals);

  // Rounding the bounds outwards can cost an interval; widen until it fits.
  while (Math.ceil(max / step) - Math.floor(min / step) > intervals) {
    step = niceStep(step * 1.5);
  }

  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 2; tick += step) {
    ticks.push(Math.round(tick * 1e6) / 1e6);
  }

  return { domain: [low, high], ticks };
}

/**
 * Whether a comparison series covers the whole range it is drawn against.
 *
 * Recharts gives every series in a category its own slot, so a second bar
 * series takes half of every month whether or not it has anything to put
 * there — and each visible bar then hangs off to one side of the month it
 * belongs to. With one previous-year figure in nine, the reader sees eight
 * misaligned bars and one grey block that looks like a rendering fault.
 *
 * So the test is *every* month, not any: a partial previous period is not a
 * comparison, and it costs the whole chart its alignment to show. The query
 * fills a month with no history as `0` (`prev?.value ?? 0`), which means a
 * zero cannot be told from an absence here — requiring every month is the
 * only honest reading of that. A genuinely zero month will hide the
 * comparison, which is a fair price and self-correcting.
 */
export function hasCompleteSeries(data: unknown[], key: string): boolean {
  if (data.length === 0) return false;

  return data.every((row) => {
    const value = (row as Record<string, unknown> | null)?.[key];
    return typeof value === "number" && Number.isFinite(value) && value !== 0;
  });
}

// Calculate Y-axis domain and ticks for forecast charts
export const calculateYAxisDomain = <
  T extends { actual?: number; forecasted?: number },
>(
  data: T[],
) => {
  const allValues = data
    .flatMap((d) => [d.actual ?? 0, d.forecasted ?? 0])
    .filter((v) => v > 0);

  if (allValues.length === 0) return { min: 0, max: 10000, ticks: [] };

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);

  // Round to nearest 2k for nice increments
  const minRounded = Math.floor(min / 2000) * 2000;
  const maxRounded = Math.ceil(max / 2000) * 2000;

  // Generate ticks in 2k increments
  const ticks: number[] = [];
  for (let i = minRounded; i <= maxRounded; i += 2000) {
    ticks.push(i);
  }

  return {
    min: minRounded,
    max: maxRounded,
    ticks,
  };
};

// Font properties for axis labels
export const AXIS_FONT_PROPS = {
  fontSize: 10,
  className: "font-hedvig-sans",
};

// Calculate Y-axis width based on font size and character count
export function getYAxisWidth(value: string | undefined | null) {
  const charLength = AXIS_FONT_PROPS.fontSize * 0.6;

  if (!value || value.length === 0) {
    return charLength * 3;
  }

  return charLength * value.length + charLength * 2;
}

// Utility hook for calculating chart margins based on tick text length
export const useChartMargin = (
  data: any[],
  dataKey: string,
  tickFormatter: (value: number) => string,
  ticks?: number[],
) => {
  // When the caller computes its own ticks, measure those rather than guessing.
  if (ticks?.length) {
    const longest = ticks
      .map(tickFormatter)
      .reduce((a, b) => (a.length > b.length ? a : b));
    return { marginLeft: 48 - longest.length * 5 };
  }

  // Calculate both min and max values from the data
  const values = data.map((d) => d[dataKey]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  // For margin calculation, use the maximum absolute value to determine tick range
  // This prevents excessive margin when range spans both negative and positive values
  const maxAbsValue = Math.max(Math.abs(minValue), Math.abs(maxValue));

  // Generate realistic tick values that Recharts would actually use
  // Use the max absolute value to determine the longest tick (which will be at the extremes)
  const tickValues = [maxAbsValue];
  if (minValue < 0) {
    tickValues.push(-maxAbsValue);
  }

  // Format all ticks and find the longest one
  const formattedTicks = tickValues.map(tickFormatter);
  const longestTick = formattedTicks.reduce((a, b) =>
    a.length > b.length ? a : b,
  );

  // Calculate dynamic margin based on actual longest tick
  // Adjusted to match target values: 100k=28, 10k=35
  // The negative sign is already included in longestTick.length, so no extra margin needed
  const marginLeft = 48 - longestTick.length * 5;

  return {
    marginLeft,
  };
};

/**
 * Formats a date string for use as a chart X-axis label.
 * Includes the year (e.g., "Jan '23") when the dataset spans more than 12 months
 * to prevent duplicate labels which cause Recharts tooltip mismatches on hover.
 */
export function formatChartMonth(dateStr: string, totalMonths: number): string {
  return format(parseISO(dateStr), totalMonths > 12 ? "MMM ''yy" : "MMM");
}

// Common chart props interface
export interface BaseChartProps {
  data: any[];
  height?: number;
  className?: string;
  showAnimation?: boolean;
}

// Get date from data index for chart selection
export function getDateFromDataIndex(
  data: any[],
  index: number,
  dateKey: string,
): Date | null {
  if (index < 0 || index >= data.length) return null;

  const item = data[index];
  const dateValue = item[dateKey];

  if (dateValue instanceof Date) {
    return dateValue;
  }

  if (typeof dateValue === "string") {
    const parsed = parseISO(dateValue);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

// Format date range for display
export function formatDateRange(
  startDate: Date,
  endDate: Date,
  locale?: string,
): string {
  const startMonth = startDate.toLocaleString(locale || "en-US", {
    month: "long",
  });
  const endMonth = endDate.toLocaleString(locale || "en-US", { month: "long" });

  if (startMonth === endMonth) {
    return startMonth;
  }

  return `${startMonth} to ${endMonth}`;
}

// Get chart type name for natural language
export function getChartTypeName(chartId: string): string {
  const chartTypeMap: Record<string, string> = {
    "monthly-revenue": "revenue",
    revenue: "revenue",
    profit: "profit",
    "burn-rate": "burn rate",
    expenses: "expenses",
    "revenue-forecast": "revenue forecast",
    runway: "runway",
    "category-expenses": "category expenses",
    "stacked-bar": "expenses",
    "revenue-trend": "revenue trends",
    "cash-flow": "cash flow",
    "growth-rate": "growth rate",
    "business-health-score": "business health score",
    "invoice-payment": "invoice payments",
    "tax-trend": "tax trends",
    "stress-test": "cash flow stress test",
  };

  return chartTypeMap[chartId] || chartId;
}
