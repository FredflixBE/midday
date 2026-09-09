import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { resolveRedisUrl } from "@midday/cache/shared-redis";
import { Chat } from "chat";

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
