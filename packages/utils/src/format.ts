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

export function formatDate(date: string, dateFormat?: string | null) {
  const parsedDate = parseISO(date);

  if (dateFormat) {
    return format(parsedDate, dateFormat);
  }

  return format(parsedDate, "P");
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
