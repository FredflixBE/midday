import { getDb } from "@jobs/init";
import { getInboxAccountInfo } from "@midday/db/queries";
import { logger, schedules } from "@trigger.dev/sdk";
import { syncInboxAccount } from "./sync-account";

export const inboxSyncScheduler = schedules.task({
  id: "inbox-sync-scheduler",
  maxDuration: 60,
  run: async (payload) => {
    if (!payload.externalId) {
      throw new Error("ID is required");
    }

    // An account deleted without its schedule — its team deleted, or the
    // schedule's own deletion failed — would otherwise be synced, and fail,
    // every six hours for good, holding one of the free plan's ten slots.
    const account = await getInboxAccountInfo(getDb(), {
      id: payload.externalId,
    });

    if (!account) {
      logger.info("Inbox account no longer exists; removing its schedule", {
        accountId: payload.externalId,
        scheduleId: payload.scheduleId,
      });
      await schedules.del(payload.scheduleId);
      return;
    }

    await syncInboxAccount.trigger({
      id: payload.externalId,
    });
  },
});
