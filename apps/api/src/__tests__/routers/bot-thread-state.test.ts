import { describe, expect, test } from "bun:test";
import { canReuseCachedThreadState } from "../../bot/thread-state";

describe("bot thread state reuse", () => {
  test("reuses cached state when the same slack user continues", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "slack",
          externalUserId: "slack_user_a",
        },
        {
          platform: "slack",
          externalUserId: "slack_user_a",
        },
      ),
    ).toBe(true);
  });

  test("does not reuse cached slack state for a different sender", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "slack",
          externalUserId: "slack_user_a",
        },
        {
          platform: "slack",
          externalUserId: "slack_user_b",
        },
      ),
    ).toBe(false);
  });

  test("does not reuse cached state for a different sender in another workspace", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "slack",
          externalUserId: "U0000AAAA",
        },
        {
          platform: "slack",
          externalUserId: "U0000BBBB",
        },
      ),
    ).toBe(false);
  });

  test("does not reuse cached state when platform is missing", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          externalUserId: "shared_user_id",
        },
        {
          platform: "slack",
          externalUserId: "shared_user_id",
        },
      ),
    ).toBe(false);
  });

  test("does not reuse cached state without a sender id", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "slack",
          externalUserId: "slack_user_a",
        },
        {
          platform: "slack",
          externalUserId: "",
        },
      ),
    ).toBe(false);
  });
});
