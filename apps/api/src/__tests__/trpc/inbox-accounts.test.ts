import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { inboxAccountsRouter } from "../../trpc/routers/inbox-accounts";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const ACCOUNT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const createCaller = createCallerFactory(inboxAccountsRouter);

describe("tRPC: inboxAccounts.get", () => {
  beforeEach(() => {
    mocks.getInboxAccounts.mockReset();
    mocks.getInboxAccounts.mockImplementation(() => Promise.resolve([]));
  });

  test("returns inbox accounts for the team", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.get();

    expect(result).toEqual([]);
    expect(mocks.getInboxAccounts).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("propagates when getInboxAccounts fails", async () => {
    mocks.getInboxAccounts.mockImplementation(() =>
      Promise.reject(new Error("database unavailable")),
    );

    const caller = createCaller(createTestContext());

    await expect(caller.get()).rejects.toThrow("database unavailable");
  });
});

describe("tRPC: inboxAccounts.delete", () => {
  beforeEach(() => {
    mocks.deleteInboxAccount.mockReset();
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve({ id: ACCOUNT_ID, scheduleId: null }),
    );
  });

  test("returns the deleted row id", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete({ id: ACCOUNT_ID });

    expect(result).toEqual({ id: ACCOUNT_ID, scheduleId: null });
    expect(mocks.deleteInboxAccount).toHaveBeenCalledWith(expect.anything(), {
      id: ACCOUNT_ID,
      teamId: "test-team-id",
    });
  });

  test("returns null when nothing was deleted", async () => {
    mocks.deleteInboxAccount.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());
    expect(await caller.delete({ id: ACCOUNT_ID })).toBeNull();
  });
});

describe("tRPC: inboxAccounts.delete, cleaning up after the account", () => {
  const deletedGmail = {
    id: ACCOUNT_ID,
    scheduleId: "sched_inbox",
    provider: "gmail",
    email: "finance@example.com",
    refreshToken: "encrypted-refresh-token",
  };

  beforeEach(() => {
    mocks.deleteInboxAccount.mockReset();
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve(deletedGmail),
    );
    mocks.deleteSchedule.mockReset();
    mocks.deleteSchedule.mockImplementation(() => Promise.resolve());
    mocks.revokeInboxAccess.mockReset();
    mocks.revokeInboxAccess.mockImplementation(() =>
      Promise.resolve("revoked"),
    );
    mocks.constructInboxConnector.mockReset();
    mocks.constructInboxConnector.mockImplementation(() => undefined);
  });

  test("deletes the account's schedule and revokes the app's access to the mailbox", async () => {
    const caller = createCaller(createTestContext());
    await caller.delete({ id: ACCOUNT_ID });

    expect(mocks.deleteSchedule).toHaveBeenCalledWith("sched_inbox");
    expect(mocks.revokeInboxAccess).toHaveBeenCalledWith({
      email: "finance@example.com",
      refreshToken: "encrypted-refresh-token",
    });
  });

  test("never hands the refresh token back to the browser", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.delete({ id: ACCOUNT_ID })).toEqual({
      id: ACCOUNT_ID,
      scheduleId: "sched_inbox",
    });
  });

  test("still succeeds when the schedule is already gone or the provider is down", async () => {
    // The row is deleted by then, so failing would only tell the user that
    // something they can no longer retry went wrong.
    mocks.deleteSchedule.mockImplementation(() =>
      Promise.reject(new Error("Schedule not found")),
    );
    mocks.revokeInboxAccess.mockImplementation(() =>
      Promise.reject(new Error("Google is unavailable")),
    );

    const caller = createCaller(createTestContext());

    expect(await caller.delete({ id: ACCOUNT_ID })).toEqual({
      id: ACCOUNT_ID,
      scheduleId: "sched_inbox",
    });
  });

  test("still succeeds when the provider's OAuth credentials are not configured", async () => {
    mocks.constructInboxConnector.mockImplementation(() => {
      throw new Error("Missing required Gmail OAuth2 credentials");
    });

    const caller = createCaller(createTestContext());

    expect(await caller.delete({ id: ACCOUNT_ID })).toEqual({
      id: ACCOUNT_ID,
      scheduleId: "sched_inbox",
    });
  });
});
