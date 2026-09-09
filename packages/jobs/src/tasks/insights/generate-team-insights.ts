import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  checkInsightDataQuality,
  createInsight,
  getInsightByPeriod,
  updateInsight,
} from "@midday/db/queries";
import type { InsightMetric } from "@midday/db/schema";
import {
  createInsightsService,
  formatDateForQuery,
  getPeriodInfo,
  getPeriodLabel,
  type PeriodType,
} from "@midday/insights";
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { notification } from "../notifications/notification";

type GenerateTeamInsightsPayload = {
  teamId: string;
  periodType: PeriodType;
  periodYear: number;
  periodNumber: number;
  currency: string;
  /** Owner's locale for formatting (e.g., "en", "sv", "de") */
  locale?: string;
  /** If true, bypass data quality checks (for testing) */
  skipDataQualityCheck?: boolean;
};

type ProcessResult = {
  insightId?: string;
  teamId: string;
  periodLabel: string;
  metricsCount: number;
  status: "created" | "updated" | "skipped" | "skipped_insufficient_data";
  skipReason?: string;
};

/**
 * Generates AI-powered business insights for a team.
 *
 * This processor uses @midday/insights to:
 * 1. Fetch current and previous period data
 * 2. Calculate all relevant metrics
 * 3. Select the 4 most important metrics using smart scoring
 * 4. Generate AI narrative content (good news first, story, actions)
 * 5. Store the complete insight in the database
 */
export class GenerateInsightsProcessor extends BaseProcessor<GenerateTeamInsightsPayload> {
  async process(
    job: JobContext<GenerateTeamInsightsPayload>,
  ): Promise<ProcessResult> {
    const {
      teamId,
      periodType,
      periodYear,
      periodNumber,
      currency,
      locale,
      skipDataQualityCheck,
    } = job.data;
    const db = getDb();

    this.logger.info("Starting insight generation", {
      teamId,
      periodType,
      periodYear,
      periodNumber,
      skipDataQualityCheck: !!skipDataQualityCheck,
    });

    // Check if insight already exists
    const existingInsight = await getInsightByPeriod(db, {
      teamId,
      periodType,
      periodYear,
      periodNumber,
    });

    if (existingInsight?.status === "completed") {
      this.logger.info("Insight already exists and is completed, skipping", {
        teamId,
        insightId: existingInsight.id,
      });
      return {
        insightId: existingInsight.id,
        teamId,
        periodLabel: getPeriodLabel(periodType, periodYear, periodNumber),
        metricsCount: existingInsight.selectedMetrics?.length ?? 0,
        status: "skipped",
      };
    }

    // Get period info from the job payload (not recalculated from current date)
    const period = getPeriodInfo(periodType, periodYear, periodNumber);

    // Check data quality before generating (unless explicitly skipped for testing)
    if (!skipDataQualityCheck) {
      const dataQuality = await checkInsightDataQuality(db, {
        teamId,
        periodStart: formatDateForQuery(period.periodStart),
        periodEnd: formatDateForQuery(period.periodEnd),
      });

      if (!dataQuality.hasSufficientData) {
        this.logger.info(
          "Skipping insight generation due to insufficient data",
          {
            teamId,
            periodType,
            periodLabel: period.periodLabel,
            skipReason: dataQuality.skipReason,
            metrics: dataQuality.metrics,
          },
        );

        return {
          teamId,
          periodLabel: period.periodLabel,
          metricsCount: 0,
          status: "skipped_insufficient_data",
          skipReason: dataQuality.skipReason,
        };
      }

      this.logger.info("Data quality check passed", {
        teamId,
        metrics: dataQuality.metrics,
      });
    } else {
      this.logger.warn("Skipping data quality check (force mode)", { teamId });
    }

    // Create or update insight record with "generating" status
    let insightId: string;
    if (existingInsight) {
      insightId = existingInsight.id;
      await updateInsight(db, {
        id: insightId,
        teamId,
        status: "generating",
      });
    } else {
      const created = await createInsight(db, {
        teamId,
        periodType,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        periodYear: period.periodYear,
        periodNumber: period.periodNumber,
        currency,
      });
      if (!created) {
        throw new Error("Failed to create insight record");
      }
      insightId = created.id;
      await updateInsight(db, {
        id: insightId,
        teamId,
        status: "generating",
      });
    }

    try {
      // Use InsightsService to generate the insight
      const insightsService = createInsightsService(db);
      const result = await insightsService.generateInsight({
        teamId,
        periodType,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        periodLabel: period.periodLabel,
        periodYear: period.periodYear,
        periodNumber: period.periodNumber,
        currency,
        locale,
      });

      await updateInsight(db, {
        id: insightId,
        teamId,
        status: "completed",
        title: result.content.title,
        selectedMetrics: result.selectedMetrics,
        allMetrics: result.allMetrics as Record<string, InsightMetric>,
        anomalies: result.anomalies,
        expenseAnomalies: result.expenseAnomalies,
        activity: result.activity,
        content: result.content,
        predictions: result.predictions,
        generatedAt: new Date(),
      });

      this.logger.info("Insight generation completed", {
        teamId,
        insightId,
        periodLabel: period.periodLabel,
        metricsCount: result.selectedMetrics.length,
      });

      // Trigger notification for new insights (not updates)
      // Must be explicitly enabled via INSIGHTS_NOTIFICATIONS_ENABLED=true
      const notificationsEnabled =
        process.env.INSIGHTS_NOTIFICATIONS_ENABLED === "true";

      if (!existingInsight && notificationsEnabled) {
        try {
          await notification.trigger({
            type: "insight_ready",
            teamId,
            insightId,
            periodType,
            periodLabel: period.periodLabel,
            periodNumber: period.periodNumber,
            periodYear: period.periodYear,
            title: result.content.title,
          });
        } catch (error) {
          // Don't fail the entire process if notification fails
          this.logger.warn("Failed to trigger insight_ready notification", {
            teamId,
            insightId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else if (!notificationsEnabled) {
        this.logger.info("Insight notifications disabled via env var", {
          teamId,
          insightId,
        });
      }

      return {
        insightId,
        teamId,
        periodLabel: period.periodLabel,
        metricsCount: result.selectedMetrics.length,
        status: existingInsight ? "updated" : "created",
      };
    } catch (error) {
      // Mark insight as failed
      await updateInsight(db, {
        id: insightId,
        teamId,
        status: "failed",
      });
      throw error;
    }
  }
}

const processor = new GenerateInsightsProcessor();

export const generateTeamInsights = schemaTask({
  id: "generate-team-insights",
  schema: z.object({
    teamId: z.string().uuid(),
    periodType: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    periodYear: z.number(),
    periodNumber: z.number(),
    currency: z.string(),
    locale: z.string().nullable().optional(),
  }),
  maxDuration: 300,
  // Rate-limited against ElevenLabs and the AI providers.
  queue: { concurrencyLimit: 2 },
  retry: { maxAttempts: 3, minTimeoutInMs: 60000, factor: 2 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "generate-team-insights", payload, ctx),
});
