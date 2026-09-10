import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type ComputeYukiGapPayload,
  computeYukiGapSchema,
} from "@jobs/schemas/yuki";
import { computeYukiGap } from "@jobs/utils/compute-yuki-gap";
import type { YukiGapReport } from "@jobs/utils/yuki-gap";
import { configFromEnv, YukiClient } from "@midday/yuki";
import { schemaTask } from "@trigger.dev/sdk";

/**
 * Works out which invoices Yuki is missing and which of them Midday's inbox
 * can supply (FF-1493). Report only: it reads Yuki and the inbox and changes
 * neither. FF-1458 is what acts on the push list.
 *
 * The client is built here, inside the run, so a worker without Yuki
 * credentials still boots — only this task fails, and says which variable is
 * missing.
 */
export class ComputeYukiGapProcessor extends BaseProcessor<ComputeYukiGapPayload> {
  async process(
    job: JobContext<ComputeYukiGapPayload>,
  ): Promise<YukiGapReport> {
    const { teamId } = job.data;

    const report = await computeYukiGap({
      db: getDb(),
      client: new YukiClient(configFromEnv()),
      teamId,
    });

    this.logger.info("Computed what Yuki is missing", {
      teamId,
      push: report.push.length,
      review: report.review.length,
      missing: report.missing.length,
      unpaidInvoices: report.unpaidInvoices,
    });

    return report;
  }
}

const processor = new ComputeYukiGapProcessor();

export const computeYukiGapTask = schemaTask({
  id: "yuki-compute-gap",
  schema: computeYukiGapSchema,
  maxDuration: 120,
  // Nothing is written, so a retry cannot double anything up — but a failure
  // here is a credential or a changed Yuki response, which a retry will not fix.
  retry: { maxAttempts: 1 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "yuki-compute-gap", payload, ctx),
});
