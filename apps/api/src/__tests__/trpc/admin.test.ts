import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { adminRouter } from "../../trpc/routers/admin";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const createCaller = createCallerFactory(adminRouter);

describe("tRPC: admin.runMaintenanceTask", () => {
  beforeEach(() => {
    mocks.triggerTask.mockClear();
  });

  test("starts the bank sync and hands back the run", async () => {
    // The token is what lets the dashboard subscribe to this one run; without
    // it the page can show that the job started and nothing more.
    mocks.triggerTask.mockImplementationOnce(() => ({
      id: "run_sync_banks",
      publicAccessToken: "token_sync_banks",
    }));

    const caller = createCaller(createTestContext());

    const result = await caller.runMaintenanceTask({ action: "sync-banks" });

    expect(result).toEqual({
      id: "run_sync_banks",
      publicAccessToken: "token_sync_banks",
    });
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "sync-institutions",
      {},
      expect.objectContaining({ idempotencyKey: "maintenance:sync-banks" }),
    );
  });

  test("starts the schedule check", async () => {
    const caller = createCaller(createTestContext());

    await caller.runMaintenanceTask({ action: "check-bank-schedules" });

    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "ensure-bank-schedulers",
      {},
      expect.anything(),
    );
  });

  test("carries an idempotency key, so a double press does not start two runs", async () => {
    const caller = createCaller(createTestContext());

    await caller.runMaintenanceTask({ action: "sync-banks" });
    await caller.runMaintenanceTask({ action: "sync-banks" });

    const [first, second] = mocks.triggerTask.mock.calls;

    expect(first?.[2]?.idempotencyKey).toBe(second?.[2]?.idempotencyKey);
    expect(first?.[2]?.idempotencyKeyTTL).toBe("5m");
  });

  test("refuses a task that is not in the maintenance list", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      // The registry is the whole allowlist: without it this mutation would
      // be a way to start any task in the deployment.
      caller.runMaintenanceTask({ action: "delete-team" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.triggerTask).not.toHaveBeenCalled();
  });
});
