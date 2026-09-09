import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type ScheduleInvoicePayload,
  scheduleInvoiceSchema,
} from "@jobs/schemas/invoices";
import { getInvoiceById, updateInvoice } from "@midday/db/queries";
import { schemaTask } from "@trigger.dev/sdk";
import { generateInvoice } from "./generate-invoice";

/**
 * Schedule Invoice Processor
 * Handles executing scheduled invoices when their scheduled time arrives.
 * This processor is triggered by a delayed job when the scheduled time is reached.
 */
export class ScheduleInvoiceProcessor extends BaseProcessor<ScheduleInvoicePayload> {
  async process(job: JobContext<ScheduleInvoicePayload>): Promise<void> {
    const { invoiceId } = job.data;
    const db = getDb();

    this.logger.info("Processing scheduled invoice", {
      jobId: job.id,
      invoiceId,
    });

    // Get the invoice to verify it's still scheduled (teamId optional)
    const invoice = await getInvoiceById(db, { id: invoiceId });

    if (!invoice) {
      this.logger.error("Invoice not found", { invoiceId });
      // Don't throw - invoice may have been deleted
      return;
    }

    if (invoice.status !== "scheduled") {
      this.logger.info("Invoice is no longer scheduled, skipping", {
        invoiceId,
        status: invoice.status,
      });
      // Don't throw - this is expected if invoice was cancelled or already sent
      return;
    }

    // Skip if this is a recurring invoice - those are handled by the recurring scheduler
    // This is a defensive check since recurring invoices shouldn't have scheduled jobs
    if (invoice.invoiceRecurringId && !invoice.scheduledJobId) {
      this.logger.info(
        "Invoice is part of recurring series without scheduledJobId, skipping",
        {
          invoiceId,
          invoiceRecurringId: invoice.invoiceRecurringId,
        },
      );
      return;
    }

    // Verify this run is the currently scheduled one for this invoice. This
    // prevents a stale run from sending if a reschedule failed to cancel it.
    // `scheduledJobId` holds the Trigger run id the API stored when it
    // scheduled the invoice, so the two compare directly.
    if (invoice.scheduledJobId && invoice.scheduledJobId !== job.id) {
      this.logger.info("Stale scheduled run detected, skipping", {
        invoiceId,
        currentRunId: job.id,
        expectedRunId: invoice.scheduledJobId,
      });
      // Don't throw - this is expected if invoice was rescheduled
      return;
    }

    // Update invoice status to unpaid before generating
    const updated = await updateInvoice(db, {
      id: invoiceId,
      teamId: invoice.teamId,
      status: "unpaid",
      // Clear the scheduled job id since it has now executed
      scheduledJobId: null,
    });

    if (!updated) {
      this.logger.error("Failed to update invoice status", { invoiceId });
      throw new Error("Failed to update invoice status");
    }

    // Queue the generate-invoice job to create PDF and send email
    await generateInvoice.trigger({
      invoiceId,
      deliveryType: "create_and_send",
    });

    this.logger.info("Scheduled invoice queued for generation", {
      invoiceId,
    });
  }
}

const processor = new ScheduleInvoiceProcessor();

// Triggered with a `delay` set to the invoice's scheduled time; the API stores
// the run id on the invoice so a reschedule can tell this run is stale.
export const scheduleInvoice = schemaTask({
  id: "schedule-invoice",
  schema: scheduleInvoiceSchema,
  machine: "micro",
  maxDuration: 60,
  queue: { concurrencyLimit: 10 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "schedule-invoice", payload, ctx),
});
