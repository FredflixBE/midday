import { logger } from "@trigger.dev/sdk";

/**
 * What the daily recurring-invoice run did, one half per job.
 *
 * `null` means that half failed. The run itself still succeeds when the
 * warning half fails, so the failure has to be legible in the output rather
 * than only in the thrown error of a run that did not happen.
 */
export interface RecurringInvoiceDayResult {
  warned: unknown;
  generated: unknown;
}

/** What `triggerAndWait` hands back, narrowed to what this needs of it. */
export type HalfResult =
  | { ok: true; output: unknown }
  | { ok: false; error: unknown };

/**
 * The order the two halves run in, and what happens when one of them fails.
 *
 * Separated from the task in `tasks/invoice/recurring-daily-scheduler.ts` so
 * that both rules can be tested without the Trigger runtime — they are the
 * whole point of folding two schedules into one.
 */
export async function runRecurringInvoiceDay(
  warn: () => Promise<HalfResult>,
  generate: () => Promise<HalfResult>,
): Promise<RecurringInvoiceDayResult> {
  // The warning goes first, so that within one run no series can be invoiced
  // before the notice that it was coming.
  const warning = await warn();

  if (!warning.ok) {
    // A warning that failed to send must not stop the invoice from being
    // generated — the invoice is the part the business depends on.
    logger.error("Upcoming-invoice warnings failed; generating anyway", {
      error: warning.error,
    });
  }

  const generation = await generate();

  if (!generation.ok) {
    logger.error("Recurring invoice generation failed", {
      error: generation.error,
    });
  }

  return {
    warned: warning.ok ? warning.output : null,
    generated: generation.ok ? generation.output : null,
  };
}
