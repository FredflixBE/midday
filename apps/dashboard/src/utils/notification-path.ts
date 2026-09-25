/**
 * The dashboard URL a notification opens: the same item the in-app list opens
 * (NotificationLink), written as a URL, because a desktop notification is
 * clicked from outside the page. The sheets read these params on any page.
 */
export function notificationPath(
  activityType: string,
  metadata: Record<string, any>,
): string {
  const recordId: string | undefined = metadata?.recordId;
  const query = (params: Record<string, string>) =>
    new URLSearchParams(params).toString();
  const invoice = (invoiceId: string) =>
    `/invoices?${query({ invoiceId, invoiceType: "details" })}`;

  switch (activityType) {
    case "invoice_paid":
    case "invoice_overdue":
    case "invoice_created":
    case "invoice_sent":
    case "invoice_scheduled":
    case "invoice_reminder_sent":
    case "invoice_cancelled":
    case "invoice_refunded":
      return recordId ? invoice(recordId) : "/invoices";

    case "transactions_created":
      if (recordId) {
        return `/transactions?${query({ transactionId: recordId })}`;
      }
      if (metadata?.dateRange) {
        return `/transactions?${query({
          start: metadata.dateRange.from,
          end: metadata.dateRange.to,
        })}`;
      }
      return "/transactions";

    case "inbox_needs_review":
    case "inbox_auto_matched":
    case "inbox_cross_currency_matched":
      if (metadata?.inboxId) {
        return `/inbox?${query({
          inboxId: metadata.inboxId,
          inboxType: "details",
        })}`;
      }
      return "/inbox";

    case "inbox_new":
      return "/inbox";

    case "recurring_series_started":
    case "recurring_series_completed":
      if (metadata?.invoiceId) {
        return invoice(metadata.invoiceId);
      }
      return recordId
        ? `/invoices?${query({ editRecurringId: recordId })}`
        : "/invoices";

    case "recurring_series_paused":
    case "recurring_invoice_upcoming":
      return recordId
        ? `/invoices?${query({ editRecurringId: recordId })}`
        : "/invoices";

    default:
      return "/";
  }
}
