import { publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { inboxWebhookRouter } from "./inbox";
import { sendblueWebhookRouter } from "./sendblue";
import { stripeWebhookRouter } from "./stripe";
import { telegramWebhookRouter } from "./telegram";
import { whatsappWebhookRouter } from "./whatsapp";

const app = new OpenAPIHono<Context>();

// Apply public middleware to all webhooks (no authentication required)
app.use("*", ...publicMiddleware);

// Mount individual webhook routes
app.route("/inbox", inboxWebhookRouter);
app.route("/sendblue", sendblueWebhookRouter);
app.route("/stripe", stripeWebhookRouter);
app.route("/telegram", telegramWebhookRouter);
app.route("/whatsapp", whatsappWebhookRouter);

export { app as webhookRouter };
