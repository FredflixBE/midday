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

export const activityNotificationFlush = schedules.task({
  id: "activity-notification-flush",
  // Every minute: batched provider notifications are only as timely as this.
  cron: "*/1 * * * *",
  machine: "micro",
  maxDuration: 60,
  run: (_payload, { ctx }) =>
    runProcessor(processor, "activity-notification-flush", {}, ctx),
});
