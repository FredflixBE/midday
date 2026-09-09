import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mocks } from "../setup";

const streamMiddayAssistantMock = mock(() =>
  Promise.resolve({
    fullStream: "assistant reply",
    cleanup: () => Promise.resolve(),
  }),
);
const toAiMessagesMock = mock(() => Promise.resolve([]));
const buildSystemPromptMock = mock(() => "system prompt");

let slackDmMessageHandler:
  | ((thread: any, message: any) => Promise<void>)
  | undefined;

mock.module("@api/chat/assistant-runtime", () => ({
  streamMiddayAssistant: streamMiddayAssistantMock,
}));

mock.module("@api/chat/prompt", () => ({
  buildSystemPrompt: buildSystemPromptMock,
}));

mock.module("@api/utils/scopes", () => ({
  expandScopes: () => ["apis.all"],
}));

mock.module("chat", () => ({
  toAiMessages: toAiMessagesMock,
}));

mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    fatal: mock(() => undefined),
  }),
}));

const botMock = {
  onNewMention: mock(() => undefined),
  onSubscribedMessage: mock(() => undefined),
  onNewMessage: mock(
    (
      _pattern: RegExp,
      handler: (thread: any, message: any) => Promise<void>,
    ) => {
      slackDmMessageHandler = handler;
    },
  ),
  onAssistantThreadStarted: mock(() => undefined),
  onAssistantContextChanged: mock(() => undefined),
  getAdapter: mock(() => ({
    setSuggestedPrompts: mock(() => Promise.resolve()),
  })),
};

mock.module("@midday/bot", () => ({
  getBot: () => botMock,
  isSlackConfigured: () => true,
  formatInboxResultMessage: mock(() => ""),
  formatNotificationContextForPrompt: mock(() => ""),
  formatProcessedUploadSummary: mock(() => ""),
  getPlatformInstructions: mock(() => ""),
  isSupportedInboxUploadMediaType: mock(() => false),
  processInboxUpload: mock(() => Promise.resolve(null)),
}));

const { registerMiddayBotRuntime } = await import("../../bot/runtime");

registerMiddayBotRuntime();

function createLinkedUser() {
  return {
    id: "user_123",
    email: "test@example.com",
    timezone: "UTC",
    locale: "en",
    dateFormat: null,
    timeFormat: 24,
    fullName: "Test User",
    team: {
      baseCurrency: "USD",
      name: "Midday Test Team",
      countryCode: "US",
    },
  };
}

function createThread(platform: "slack") {
  const posts: string[] = [];
  const sendMediaMessageMock = mock(() => Promise.resolve());

  return {
    posts,
    sendMediaMessageMock,
    thread: {
      adapter: { name: platform, sendMediaMessage: sendMediaMessageMock },
      id: `${platform}_thread_123`,
      channelId: `${platform}_channel_123`,
      isDM: platform === "slack",
      recentMessages: [],
      state: {},
      setState: mock(() => Promise.resolve()),
      post: mock((text: string) => {
        posts.push(text);
        return Promise.resolve();
      }),
      startTyping: mock(() => Promise.resolve()),
      subscribe: mock(() => Promise.resolve()),
      refresh: mock(() => Promise.resolve()),
    },
  };
}

function primeCommonLinkingMocks() {
  mocks.hasTeamAccess.mockReset();
  mocks.hasTeamAccess.mockImplementation(() => Promise.resolve(true));
  mocks.getTeamById.mockReset();
  mocks.getTeamById.mockImplementation(() =>
    Promise.resolve({ name: "Midday Test Team" }),
  );
  mocks.getUserById.mockReset();
  mocks.getUserById.mockImplementation(() =>
    Promise.resolve(createLinkedUser()),
  );
  mocks.createOrUpdatePlatformIdentity.mockReset();
  mocks.createOrUpdatePlatformIdentity.mockImplementation(() =>
    Promise.resolve({ id: "identity_123" }),
  );

  streamMiddayAssistantMock.mockReset();
  streamMiddayAssistantMock.mockImplementation(() =>
    Promise.resolve({
      fullStream: "assistant reply",
      cleanup: () => Promise.resolve(),
    }),
  );
  toAiMessagesMock.mockReset();
  toAiMessagesMock.mockImplementation(() => Promise.resolve([]));
  buildSystemPromptMock.mockReset();
  buildSystemPromptMock.mockImplementation(() => "system prompt");

  mocks.consumePlatformLinkToken.mockReset();
  mocks.consumePlatformLinkToken.mockImplementation(() =>
    Promise.resolve({
      code: "abc12345",
      provider: "slack",
      teamId: "team_123",
      userId: "user_123",
    }),
  );

  mocks.getPlatformIdentity.mockReset();
  mocks.getPlatformIdentity
    .mockImplementationOnce(() => Promise.resolve(null))
    .mockImplementationOnce(() =>
      Promise.resolve({
        id: "identity_123",
        teamId: "team_123",
        userId: "user_123",
        metadata: null,
      }),
    );
}

describe("bot runtime link-code consumption", () => {
  beforeEach(() => {
    primeCommonLinkingMocks();

    mocks.getAppBySlackTeamId.mockReset();
    mocks.getAppBySlackTeamId.mockImplementation(() => Promise.resolve(null));
  });

  test("consumes a first-time Slack link code before assistant processing", async () => {
    const { posts, thread } = createThread("slack");
    const message = {
      id: "message_123",
      text: "Connect to Midday: abc12345",
      raw: {
        team: "T123",
      },
      author: {
        userId: "U123",
        fullName: "Slack User",
        userName: "slack_user",
      },
      attachments: [],
    };

    mocks.consumePlatformLinkToken.mockReset();
    mocks.consumePlatformLinkToken.mockImplementation(() =>
      Promise.resolve({
        code: "abc12345",
        provider: "slack",
        teamId: "team_123",
        userId: "user_123",
      }),
    );

    await slackDmMessageHandler?.(thread, message);

    expect(posts).toEqual([
      "Connected to Midday Test Team. You can ask Midday questions, upload receipts, and track invoices right from Slack.\n\nYou'll receive notifications for new transactions, invoices, and match suggestions (all on by default). To manage these, go to Apps \u2192 Slack \u2192 Settings in Midday.\n\nTry asking \u201cWhat's my cash flow this month?\u201d",
    ]);
    expect(streamMiddayAssistantMock).not.toHaveBeenCalled();
    expect(toAiMessagesMock).not.toHaveBeenCalled();
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(thread.startTyping).not.toHaveBeenCalled();
  });

  test("re-connects Slack DM when an existing identity exists and a new link code is sent", async () => {
    const { posts, thread } = createThread("slack");
    const message = {
      id: "message_123",
      text: "Connect to Midday: xyzABCDE",
      raw: {
        team: "T123",
      },
      author: {
        userId: "U123",
        fullName: "Slack User",
        userName: "slack_user",
      },
      attachments: [],
    };

    mocks.consumePlatformLinkToken.mockReset();
    mocks.consumePlatformLinkToken.mockImplementation(() =>
      Promise.resolve({
        code: "xyzABCDE",
        provider: "slack",
        teamId: "team_new",
        userId: "user_new",
      }),
    );

    mocks.hasTeamAccess.mockReset();
    mocks.hasTeamAccess.mockImplementation(() => Promise.resolve(true));

    mocks.getPlatformIdentity.mockReset();
    mocks.getPlatformIdentity.mockImplementation(() =>
      Promise.resolve({
        id: "stale_identity",
        teamId: "team_old",
        userId: "user_old",
        metadata: null,
      }),
    );

    mocks.createOrUpdatePlatformIdentity.mockReset();
    mocks.createOrUpdatePlatformIdentity.mockImplementation(() =>
      Promise.resolve({ id: "identity_new" }),
    );

    mocks.getTeamById.mockReset();
    mocks.getTeamById.mockImplementation(() =>
      Promise.resolve({ name: "New Slack Team" }),
    );

    await slackDmMessageHandler?.(thread, message);

    expect(posts).toEqual([
      "Connected to New Slack Team. You can ask Midday questions, upload receipts, and track invoices right from Slack.\n\nYou'll receive notifications for new transactions, invoices, and match suggestions (all on by default). To manage these, go to Apps \u2192 Slack \u2192 Settings in Midday.\n\nTry asking \u201cWhat's my cash flow this month?\u201d",
    ]);
    expect(mocks.consumePlatformLinkToken).toHaveBeenCalled();
    expect(mocks.createOrUpdatePlatformIdentity).toHaveBeenCalled();
    expect(streamMiddayAssistantMock).not.toHaveBeenCalled();
  });

  test("connected Slack DM user sending bare alphanumeric message gets assistant reply, not invalid-code error", async () => {
    const { posts, thread } = createThread("slack");
    const message = {
      id: "message_123",
      text: "test1234",
      raw: {
        team: "T123",
      },
      author: {
        userId: "U123",
        fullName: "Slack User",
        userName: "slack_user",
      },
      attachments: [],
    };

    mocks.consumePlatformLinkToken.mockReset();
    mocks.consumePlatformLinkToken.mockImplementation(() =>
      Promise.resolve(null),
    );

    mocks.hasTeamAccess.mockReset();
    mocks.hasTeamAccess.mockImplementation(() => Promise.resolve(true));

    mocks.getPlatformIdentity.mockReset();
    mocks.getPlatformIdentity.mockImplementation(() =>
      Promise.resolve({
        id: "identity_123",
        teamId: "team_123",
        userId: "user_123",
        metadata: null,
      }),
    );

    mocks.getUserById.mockReset();
    mocks.getUserById.mockImplementation(() =>
      Promise.resolve(createLinkedUser()),
    );

    await slackDmMessageHandler?.(thread, message);

    expect(posts).not.toContain(
      "That Slack link code is invalid or expired. Open Midday and generate a new one.",
    );
    expect(streamMiddayAssistantMock).toHaveBeenCalled();
    expect(thread.startTyping).toHaveBeenCalled();
  });
});
