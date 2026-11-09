import { checkModels, type ModelCheck } from "@midday/ai";
import { logger, task } from "@trigger.dev/sdk";

/** What a run found, for whoever pressed the button in Settings → Admin. */
export interface CheckAiModelsResult {
  checks: ModelCheck[];
}

/**
 * One real call to every AI model in use, from the jobs' own environment.
 *
 * Proves the keys set in Trigger.dev and every model id in `@midday/ai` work
 * here, without waiting for an inbox document or a bank sync to find out.
 * A failed model fails the run, so it shows as failed in Trigger.dev too.
 */
export const checkAiModels = task({
  id: "check-ai-models",
  maxDuration: 120,
  queue: { concurrencyLimit: 1 },
  // A failure here is the answer, not a hiccup to retry into more spend.
  retry: { maxAttempts: 1 },
  run: async (): Promise<CheckAiModelsResult> => {
    const checks = await checkModels();

    for (const check of checks) {
      if (check.ok) {
        logger.info("AI model answered", {
          model: check.model,
          purposes: check.purposes,
          ms: check.ms,
        });
      } else {
        logger.error("AI model failed", { ...check });
      }
    }

    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      throw new Error(
        `AI model check failed: ${failed
          .map((check) => `${check.model} (${check.error})`)
          .join("; ")}`,
      );
    }

    return { checks };
  },
});
