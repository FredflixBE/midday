import {
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
 * 05:00 UTC, so that a series due at UTC midnight is invoiced on the same UTC
 * day it is dated, and early enough to reach a European inbox in the morning.
 *
 * Both halves stay tasks of their own, so either can still be run alone.
 */
export const invoiceRecurringDailyScheduler = schedules.task({
  id: "invoice-recurring-daily",
  cron: "0 5 * * *",
  // Waiting on the two children is not compute time; this covers the run's own
  // work either side of the waits.
  maxDuration: 300,
  // The payload is deliberately ignored, so that this also runs correctly when
  // triggered by hand from Settings → Admin, which sends none.
  run: (): Promise<RecurringInvoiceDayResult> =>
    runRecurringInvoiceDay(
      () => invoiceUpcomingNotification.triggerAndWait({}),
      () => invoiceRecurringScheduler.triggerAndWait({}),
    ),
});
