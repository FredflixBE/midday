import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { Chat } from "chat";

/**
 * The Slack chat adapter keeps thread state in Redis. Nothing else in this
 * fork needs Redis any more, so the URL is read here rather than shared, and
 * is only required if you actually turn the Slack bot on.
 */
function resolveRedisUrl(): string {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error(
      "The Slack bot needs Redis for thread state: set REDIS_URL, or leave SLACK_SIGNING_SECRET unset to keep the bot off",
    );
  }

  return url;
}

export function createMiddayBot() {
  return new Chat({
    userName: "midday",
    adapters: {
      slack: createSlackAdapter(),
    },
    state: createRedisState({ url: resolveRedisUrl() }),
    concurrency: {
      strategy: "debounce",
      debounceMs: 1500,
    },
  });
}

export type MiddayBot = ReturnType<typeof createMiddayBot>;

/**
 * The Slack adapter validates SLACK_SIGNING_SECRET in its constructor, so the
 * bot must not be built at import: a self-host without a Slack app still has
 * to boot the API and worker.
 */
export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET);
}

let instance: MiddayBot | null = null;

/**
 * The shared bot, created on first use. Throws when Slack is not configured;
 * check `isSlackConfigured()` first on request paths that should degrade.
 */
export function getBot(): MiddayBot {
  if (!isSlackConfigured()) {
    throw new Error(
      "Slack is not configured: set SLACK_SIGNING_SECRET to enable the Slack app",
    );
  }

  if (!instance) {
    instance = createMiddayBot();
  }

  return instance;
}
