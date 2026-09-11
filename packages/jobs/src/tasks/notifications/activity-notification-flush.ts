import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import { flushDueActivityNotificationBatches } from "@midday/bot/activity-notifications";
import { task } from "@trigger.dev/sdk";
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

// No cron. This used to run every minute, because batched provider
// notifications are only as timely as their flush — but the only provider is
// Slack, which is on hold in this fork, so it was about 43,000 runs a month
// that found nothing to send, for one of the ten schedules the free plan
// allows (FF-1521).
//
// The processor stays, and so does the task, so putting the minute back is a
// one-line change on the day Slack comes off hold.
export const activityNotificationFlush = task({
  id: "activity-notification-flush",
  machine: "micro",
  maxDuration: 60,
  run: (_payload: Record<string, never>, { ctx }) =>
    runProcessor(processor, "activity-notification-flush", {}, ctx),
});
