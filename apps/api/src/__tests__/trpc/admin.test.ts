import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { adminRouter } from "../../trpc/routers/admin";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const createCaller = createCallerFactory(adminRouter);

/** The address `createTestContext` signs the caller in as. */
const DEVELOPER = "test@example.com";
const originalDeveloperEmail = process.env.DEVELOPER_EMAIL;

afterAll(() => {
  if (originalDeveloperEmail === undefined) {
    delete process.env.DEVELOPER_EMAIL;
  } else {
    process.env.DEVELOPER_EMAIL = originalDeveloperEmail;
  }
});

describe("tRPC: admin.runMaintenanceTask", () => {
  beforeEach(() => {
    process.env.DEVELOPER_EMAIL = DEVELOPER;
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

  test("refuses a team member who is not the developer", async () => {
    // Hiding the tab is not a guard: the mutation stays reachable, so this is
    // the check that has to hold.
    process.env.DEVELOPER_EMAIL = "someone-else@example.com";

    const caller = createCaller(createTestContext());

    await expect(
      caller.runMaintenanceTask({ action: "sync-banks" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.triggerTask).not.toHaveBeenCalled();
  });

  test("refuses everyone when no developer is configured", async () => {
    delete process.env.DEVELOPER_EMAIL;

    const caller = createCaller(createTestContext());

    await expect(
      caller.runMaintenanceTask({ action: "sync-banks" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.triggerTask).not.toHaveBeenCalled();
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

describe("tRPC: admin.isDeveloper", () => {
  test("tells the developer that they are one", async () => {
    process.env.DEVELOPER_EMAIL = DEVELOPER;

    const caller = createCaller(createTestContext());

    expect(await caller.isDeveloper()).toBe(true);
  });

  test("tells everyone else that they are not", async () => {
    process.env.DEVELOPER_EMAIL = "someone-else@example.com";

    const caller = createCaller(createTestContext());

    expect(await caller.isDeveloper()).toBe(false);
  });
});
