import { registerMiddayBotRuntime } from "@api/bot/runtime";
import type { Context } from "@api/rest/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getBot, isSlackConfigured } from "@midday/bot";

const app = new OpenAPIHono<Context>();

app.post("/", async (c) => {
  // Slack is optional on a self-host; without its credentials the bot cannot
  // be built, so answer clearly instead of failing at import time.
  if (!isSlackConfigured()) {
    return c.json({ error: "Slack is not configured" }, 503);
  }

  registerMiddayBotRuntime();

  const bot = getBot();
  await bot.initialize();
  return bot.webhooks.slack(c.req.raw);
});

export { app as webhookRouter };
