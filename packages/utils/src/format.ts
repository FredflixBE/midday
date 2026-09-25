import { format, parseISO } from "date-fns";

type FormatAmountParams = {
  currency: string;
  amount: number;
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  /**
   * Left to `Intl`'s default unless asked for. This formatter also renders
   * invoices, the client portal and invoice emails, and how a client's
   * document shows a dollar is not decided by how the app shows one
   * (FF-1573).
   */
  currencyDisplay?: Intl.NumberFormatOptions["currencyDisplay"];
};

export function formatAmount({
  currency,
  amount,
  locale = "en-US",
  minimumFractionDigits,
  maximumFractionDigits,
  currencyDisplay,
}: FormatAmountParams) {
  if (!currency) {
    return;
  }

  return Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
}

/**
 * How a date is shown when nobody has chosen a format (FF-1539): the user's
 * own setting under Account → Date and locale, or an invoice template's.
 *
 * Day first, because a month-first date beside an amount is misread by every
 * reader who is not American. One of the four formats that setting offers, so
 * the setting can show it as the one in effect. And a fixed pattern, never
 * date-fns' "P"/"PPP": those follow the locale date-fns was given, which is
 * en-US unless one is passed.
 */
export const DEFAULT_DATE_FORMAT = "dd/MM/yyyy";

export function formatDate(date: string, dateFormat?: string | null) {
  return format(parseISO(date), dateFormat || DEFAULT_DATE_FORMAT);
}

export function getInitials(value: string) {
  const formatted = value.toUpperCase().replace(/[\s.-]/g, "");

  if (formatted.split(" ").length > 1) {
    return `${formatted.charAt(0)}${formatted.charAt(1)}`;
  }

  if (value.length > 1) {
    return formatted.charAt(0) + formatted.charAt(1);
  }

  return formatted.charAt(0);
}
