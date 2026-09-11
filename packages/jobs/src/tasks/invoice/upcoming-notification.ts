import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type InvoiceUpcomingNotificationPayload,
  invoiceUpcomingNotificationSchema,
} from "@jobs/schemas/invoices";
import { sendToProviders } from "@midday/bot/activity-notifications";
import {
  getUpcomingDueRecurring,
  markUpcomingNotificationSent,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import { isFlagEnabled } from "@midday/utils/flags";
import { task } from "@trigger.dev/sdk";

/**
 * How far ahead a warning looks.
 *
 * This was 24 while the job ran hourly, which gave every series a warning
 * between 23 and 24 hours before it was generated. Now that the job runs once
 * a day (FF-1522), a 24-hour window would miss almost everything: a series due
 * 25 hours after today's run is outside it, and by tomorrow's run it is an
 * hour away — warned, but not warned *ahead*.
 *
 * 48 restores the promise. Each daily run warns about everything due before
 * the run after next, so every series is warned at least 24 hours ahead, and
 * only once: the query treats a notification sent less than `hoursAhead + 1`
 * before the due date as belonging to this cycle rather than the last.
 */
const LOOK_AHEAD_HOURS = 48;

type ProcessResult = {
  processed: number;
  skipped: number;
  failed: number;
  errors: Array<{ teamId: string; error: string }>;
  hasMore: boolean;
};

/**
 * Sends notifications for upcoming recurring invoices, warning a team about
 * the invoices that its series will generate within the look-ahead window.
 *
 * This gives users time to:
 * - Review the recurring series settings
 * - Pause the series if needed
 * - Update details before the invoice goes out
 *
 * Notifications are batched per team - if a team has multiple recurring invoices
 * due on the same day, they receive a single summary notification.
 */
export class InvoiceUpcomingNotificationProcessor extends BaseProcessor<InvoiceUpcomingNotificationPayload> {
  async process(
    _job: JobContext<InvoiceUpcomingNotificationPayload>,
  ): Promise<ProcessResult> {
    // Kill switch - can be toggled without deploy via environment variable
    if (process.env.DISABLE_UPCOMING_NOTIFICATIONS === "true") {
      this.logger.warn(
        "Upcoming invoice notifications disabled via DISABLE_UPCOMING_NOTIFICATIONS",
      );
      return {
        processed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        hasMore: false,
      };
    }

    const db = getDb();

    // Dry run: work out who would be notified and log it, without sending.
    // See the note on the same flag in generate-recurring.ts.
    if (isFlagEnabled("INVOICE_JOBS_DRY_RUN", { defaultValue: false })) {
      this.logger.info(
        "[DRY RUN] Upcoming invoice notification processor - logging only, no execution",
      );

      const { data: upcomingRecurring, hasMore } =
        await getUpcomingDueRecurring(db, LOOK_AHEAD_HOURS);

      if (upcomingRecurring.length === 0) {
        this.logger.info("[DRY RUN] No upcoming invoices to notify about");
        return {
          processed: 0,
          skipped: 0,
          failed: 0,
          errors: [],
          hasMore: false,
        };
      }

      // Group invoices by teamId for logging
      const invoicesByTeam = new Map<string, typeof upcomingRecurring>();
      for (const invoice of upcomingRecurring) {
        const existing = invoicesByTeam.get(invoice.teamId) || [];
        existing.push(invoice);
        invoicesByTeam.set(invoice.teamId, existing);
      }

      this.logger.info(
        `[DRY RUN] Would notify ${invoicesByTeam.size} teams about ${upcomingRecurring.length} upcoming invoices${hasMore ? " (more pending)" : ""}`,
        {
          teamCount: invoicesByTeam.size,
          invoiceCount: upcomingRecurring.length,
          hasMore,
          teams: Array.from(invoicesByTeam.entries()).map(
            ([teamId, invoices]) => ({
              teamId,
              invoiceCount: invoices.length,
              invoices: invoices.map((inv) => ({
                recurringId: inv.id,
                customerName: inv.customerName,
                amount: inv.amount,
                currency: inv.currency,
                scheduledAt: inv.nextScheduledAt,
              })),
            }),
          ),
        },
      );

      // Return simulated results
      return {
        processed: invoicesByTeam.size,
        skipped: 0,
        failed: 0,
        errors: [],
        hasMore,
      };
    }

    const notifications = new Notifications(db);

    this.logger.info("Starting upcoming invoice notification processor");

    // Series due inside the look-ahead that have not been warned yet for this
    // cycle (batched, default limit: 100).
    const { data: upcomingRecurring, hasMore } = await getUpcomingDueRecurring(
      db,
      LOOK_AHEAD_HOURS,
    );

    if (upcomingRecurring.length === 0) {
      this.logger.info("No upcoming invoices to notify about");
      return {
        processed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        hasMore: false,
      };
    }

    this.logger.info(
      `Found ${upcomingRecurring.length} upcoming invoices to notify about${hasMore ? " (more pending)" : ""}`,
      { count: upcomingRecurring.length, hasMore },
    );

    // Filter out invoices that have already been notified for this cycle
    const eligibleInvoices = upcomingRecurring.filter((recurring) => {
      if (recurring.upcomingNotificationSentAt && recurring.nextScheduledAt) {
        const notificationSentAt = new Date(
          recurring.upcomingNotificationSentAt,
        );
        const nextScheduled = new Date(recurring.nextScheduledAt);
        // A warning sent inside the look-ahead (plus the hour of slack the
        // query allows) was for this cycle, not the last one. Derived from
        // LOOK_AHEAD_HOURS rather than written out, so that widening the
        // window cannot leave this guard behind sending a second warning.
        const hoursDiff =
          (nextScheduled.getTime() - notificationSentAt.getTime()) /
          (1000 * 60 * 60);
        if (hoursDiff < LOOK_AHEAD_HOURS + 1) {
          this.logger.info(
            "Notification already sent for this cycle, skipping",
            {
              recurringId: recurring.id,
              upcomingNotificationSentAt: recurring.upcomingNotificationSentAt,
              nextScheduledAt: recurring.nextScheduledAt,
            },
          );
          return false;
        }
      }
      return true;
    });

    const skipped = upcomingRecurring.length - eligibleInvoices.length;

    if (eligibleInvoices.length === 0) {
      this.logger.info("All upcoming invoices already notified");
      return {
        processed: 0,
        skipped,
        failed: 0,
        errors: [],
        hasMore,
      };
    }

    // Group invoices by teamId for batched notifications
    const invoicesByTeam = new Map<string, typeof eligibleInvoices>();

    for (const invoice of eligibleInvoices) {
      const existing = invoicesByTeam.get(invoice.teamId) || [];
      existing.push(invoice);
      invoicesByTeam.set(invoice.teamId, existing);
    }

    this.logger.info(
      `Grouped ${eligibleInvoices.length} invoices into ${invoicesByTeam.size} teams`,
    );

    const errors: Array<{ teamId: string; error: string }> = [];
    let processed = 0;
    let failed = 0;

    // Process each team's batch
    for (const [teamId, teamInvoices] of invoicesByTeam.entries()) {
      try {
        // Create batched notification for the team
        await notifications.create(
          "recurring_invoice_upcoming",
          teamId,
          {
            invoices: teamInvoices.map((inv) => ({
              recurringId: inv.id,
              customerName: inv.customerName ?? undefined,
              amount: inv.amount ?? undefined,
              currency: inv.currency ?? undefined,
              scheduledAt: inv.nextScheduledAt!,
              frequency: inv.frequency,
            })),
            count: teamInvoices.length,
          },
          { sendEmail: true },
        );

        // Mark all invoices in this batch as notified before best-effort
        // secondary delivery so a sendToProviders failure can't prevent marking
        // and cause duplicate emails on retry.
        for (const invoice of teamInvoices) {
          await markUpcomingNotificationSent(db, {
            id: invoice.id,
            teamId: invoice.teamId,
          });
        }

        try {
          await sendToProviders(db, teamId, "recurring_invoice_upcoming", {
            invoices: teamInvoices.map((inv) => ({
              recurringId: inv.id,
              customerName: inv.customerName ?? undefined,
              amount: inv.amount ?? undefined,
              currency: inv.currency ?? undefined,
              scheduledAt: inv.nextScheduledAt!,
              frequency: inv.frequency,
            })),
            count: teamInvoices.length,
          });
        } catch (providerError) {
          this.logger.error(
            "Best-effort sendToProviders failed for upcoming invoice notification",
            {
              teamId,
              error:
                providerError instanceof Error
                  ? providerError.message
                  : "Unknown error",
            },
          );
        }

        this.logger.info("Sent batched upcoming invoice notification", {
          teamId,
          invoiceCount: teamInvoices.length,
          customerNames: teamInvoices
            .map((inv) => inv.customerName)
            .filter(Boolean),
        });

        processed++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.error(
          "Failed to send batched upcoming invoice notification",
          {
            teamId,
            invoiceCount: teamInvoices.length,
            error: errorMessage,
          },
        );

        errors.push({
          teamId,
          error: errorMessage,
        });
        failed++;
      }
    }

    this.logger.info("Upcoming invoice notification processor completed", {
      teamsProcessed: processed,
      teamsFailed: failed,
      invoicesSkipped: skipped,
      totalInvoices: upcomingRecurring.length,
      hasMore,
    });

    if (hasMore) {
      this.logger.info(
        "More upcoming invoices pending - will be processed in next scheduler run",
      );
    }

    return {
      processed,
      skipped,
      failed,
      errors,
      hasMore,
    };
  }
}

const processor = new InvoiceUpcomingNotificationProcessor();

// No cron of its own. The recurring-invoice feature has one daily schedule,
// `invoice-recurring-daily`, which runs this before the generation (FF-1522).
// Keeping it a task of its own means it can still be run alone, from Settings
// → Admin or from the Trigger.dev dashboard.
export const invoiceUpcomingNotification = task({
  id: "invoice-upcoming-notification",
  maxDuration: 300,
  run: (_payload: InvoiceUpcomingNotificationPayload, { ctx }) =>
    runProcessor(processor, "invoice-upcoming-notification", {}, ctx),
});
