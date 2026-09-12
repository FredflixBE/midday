import {
  RECURRING_INVOICE_CRON,
  type RecurringInvoiceDayResult,
  runRecurringInvoiceDay,
} from "@jobs/utils/recurring-invoice-day";
import { schedules } from "@trigger.dev/sdk";
import { invoiceRecurringScheduler } from "./generate-recurring";
import { invoiceUpcomingNotification } from "./upcoming-notification";

/**
 * The recurring-invoice feature's one schedule.
 *
 * It used to be two, both hourly: one to warn a day ahead that an invoice was
 * coming, one to generate what was due. That is two of the ten schedules the
 * free plan allows (FF-1521), for a feature whose unit is a month.
 *
 * Hourly bought nothing. An invoice's issue date comes from the series'
 * `nextScheduledAt` normalised to UTC midnight, not from when the run
 * happened, so a series due at 00:00 UTC gets the same invoice whether it is
 * generated at 00:05 or at 05:00 — only the email goes out later. And nothing
 * is lost by running late: the generation query takes everything with
 * `nextScheduledAt <= now`, so an overdue series is picked up by the next run
 * rather than skipped.
 *
 * The cron and the warning's look-ahead are tied together, and the reason is
 * on `RECURRING_INVOICE_CRON`.
 *
 * Both halves stay tasks of their own, so either can still be run alone.
 */
export const invoiceRecurringDailyScheduler = schedules.task({
  id: "invoice-recurring-daily",
  cron: RECURRING_INVOICE_CRON,
  // Waiting on the two children is wall-clock, not compute, but this task
  // spends almost none of either itself.
  maxDuration: 300,
  // One at a time. A daily schedule cannot overlap itself, but the button on
  // Settings → Admin can be pressed while a run is going.
  queue: { concurrencyLimit: 1 },
  // The payload is deliberately ignored, so that this also runs correctly when
  // triggered by hand from Settings → Admin, which sends none.
  run: (): Promise<RecurringInvoiceDayResult> =>
    runRecurringInvoiceDay(
      () => invoiceUpcomingNotification.triggerAndWait({}),
      () => invoiceRecurringScheduler.triggerAndWait({}),
    ),
});
