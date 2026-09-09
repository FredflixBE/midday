import { publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { isInboxForwardingEnabled } from "@midday/inbox";
import { inboxWebhookRouter } from "./inbox";
import { stripeWebhookRouter } from "./stripe";

const app = new OpenAPIHono<Context>();

// Apply public middleware to all webhooks (no authentication required)
app.use("*", ...publicMiddleware);

// Mount individual webhook routes.
// Inbound email is optional: without INBOX_FORWARDING_DOMAIN there is no
// address to forward to, so the route does not exist at all.
if (isInboxForwardingEnabled()) {
  app.route("/inbox", inboxWebhookRouter);
}
app.route("/stripe", stripeWebhookRouter);

export { app as webhookRouter };
