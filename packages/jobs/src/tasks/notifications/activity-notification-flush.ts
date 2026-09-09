import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import { flushDueActivityNotificationBatches } from "@midday/bot/activity-notifications";
import { schedules } from "@trigger.dev/sdk";
import { z } from "zod";

const flushPayloadSchema = z.object({});

export class ActivityNotificationFlushProcessor extends BaseProcessor<
  z.infer<typeof flushPayloadSchema>
> {
  protected override getPayloadSchema() {
    return flushPayloadSchema;
  }

  async process(_job: JobContext<z.infer<typeof flushPayloadSchema>>) {
    await flushDueActivityNotificationBatches(getDb());

    return { flushed: true };
  }
}

const processor = new ActivityNotificationFlushProcessor();

// No `cron` yet — FF-1387 registers the schedules.
export const activityNotificationFlush = schedules.task({
  id: "activity-notification-flush",
  machine: "micro",
  maxDuration: 60,
  run: (_payload, { ctx }) =>
    runProcessor(processor, "activity-notification-flush", {}, ctx),
});
