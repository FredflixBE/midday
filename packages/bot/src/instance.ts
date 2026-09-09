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

export const bot = createMiddayBot();
