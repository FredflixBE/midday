import type { Context } from "@api/rest/types";
import { createAdminClient } from "@api/services/supabase";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getTeamByInboxId } from "@midday/db/queries";
import { getAllowedAttachments } from "@midday/documents";
import {
  getInboxForwardingDomain,
  getInboxIdFromEmail,
  inboxWebhookPostSchema,
} from "@midday/inbox";
import { logger } from "@midday/logger";
import { getEmailFrom } from "@midday/utils/email-from";
import { getResend } from "@midday/utils/resend";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import {
  ALLOWED_FORWARDING_EMAILS,
  filterAttachments,
  triggerProcessingJobs,
  type UploadResult,
  uploadAttachment,
} from "./utils";

const app = new OpenAPIHono<Context>();

// HTTP Basic Authentication. An inbound email provider supports this by
// putting credentials in the webhook URL:
// https://username:password@domain.com/webhook/inbox
//
// This is the only thing standing between the internet and this route — the
// old defence was an allowlist of Postmark's four IPs, which is wrong for any
// other provider and is not a substitute for authentication. Without
// credentials the route refuses every request rather than running open.
const webhookUsername = process.env.INBOX_WEBHOOK_USERNAME;
const webhookPassword = process.env.INBOX_WEBHOOK_PASSWORD;

if (webhookUsername && webhookPassword) {
  app.use(
    "*",
    basicAuth({ username: webhookUsername, password: webhookPassword }),
  );
} else {
  app.use("*", () => {
    logger.warn(
      "Inbox webhook called without INBOX_WEBHOOK_USERNAME/PASSWORD configured",
    );
    throw new HTTPException(503, {
      message: "Inbox webhook is not configured",
    });
  });
}

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    summary: "Inbox webhook",
    operationId: "inboxWebhook",
    description: "Webhook endpoint for receiving inbox emails from Postmark",
    tags: ["Webhooks"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.any(), // Schema validated manually using inboxWebhookPostSchema
          },
        },
      },
    },
    responses: {
      200: {
        description: "Webhook processed successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
            }),
          },
        },
      },
      400: {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: z.object({
              error: z.string(),
              errors: z
                .array(
                  z.object({
                    path: z.string(),
                    message: z.string(),
                  }),
                )
                .optional(),
            }),
          },
        },
      },
      403: {
        description: "Invalid IP address",
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: z.object({
              error: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const body = await c.req.json();
    const parsedBody = inboxWebhookPostSchema.safeParse(body);

    if (!parsedBody.success) {
      const errors = parsedBody.error.issues.map((error) => ({
        path: error.path.join("."),
        message: error.message,
      }));

      return c.json(
        {
          error: "Invalid request body",
          errors,
        },
        400,
      );
    }

    const {
      MessageID,
      FromFull,
      Subject,
      Attachments,
      OriginalRecipient,
      TextBody,
      HtmlBody,
    } = parsedBody.data;

    const forwardingDomain = getInboxForwardingDomain();
    const inboxId = getInboxIdFromEmail(OriginalRecipient);

    if (!inboxId || !OriginalRecipient.endsWith(`@${forwardingDomain}`)) {
      throw new HTTPException(400, {
        message: "Invalid OriginalRecipient email",
      });
    }

    logger.info("Inbox webhook received", {
      messageId: MessageID,
      inboxId,
      senderEmail: FromFull.Email,
      attachmentCount: Attachments?.length ?? 0,
    });

    // Ignore emails we sent ourselves, to fix an infinite loop
    if (FromFull.Email.endsWith(`@${forwardingDomain}`)) {
      logger.info("Ignoring email from own domain", {
        messageId: MessageID,
        inboxId,
      });
      return c.json({ success: true });
    }

    const db = c.get("db");
    const supabase = await createAdminClient();

    try {
      const teamData = await getTeamByInboxId(db, inboxId);

      if (!teamData) {
        logger.warn("Team not found for inbox", {
          inboxId,
          messageId: MessageID,
        });
        throw new HTTPException(404, {
          message: `Team not found for inbox_id: ${inboxId}`,
        });
      }

      const teamId = teamData.id;

      logger.info("Team found for inbox", {
        teamId,
        inboxId,
        messageId: MessageID,
      });

      // If the email is forwarded from a Google Workspace account, we need to send a reply to the team email
      if (
        teamData.email &&
        ALLOWED_FORWARDING_EMAILS.includes(FromFull.Email as any)
      ) {
        logger.info("Processing Google Workspace forwarded email", {
          teamId,
          inboxId,
          messageId: MessageID,
        });

        await getResend().emails.send({
          from: getEmailFrom(FromFull?.Name),
          to: teamData.email,
          subject: Subject ?? FromFull?.Name,
          text: TextBody,
          html: HtmlBody,
          react: null,
          headers: {
            "X-Entity-Ref-ID": nanoid(),
          },
        });

        return c.json({ success: true });
      }

      const allowedAttachments = getAllowedAttachments(Attachments);

      if (!allowedAttachments?.length) {
        logger.info("No allowed attachments", {
          teamId,
          inboxId,
          messageId: MessageID,
          totalAttachments: Attachments?.length ?? 0,
        });
        return c.json({ success: true });
      }

      logger.info("Processing attachments", {
        teamId,
        inboxId,
        messageId: MessageID,
        allowedCount: allowedAttachments.length,
        totalAttachments: Attachments?.length ?? 0,
      });

      // Filter attachments by size (exclude small images except PDFs)
      const filteredAttachments = filterAttachments(allowedAttachments);

      if (!filteredAttachments.length) {
        logger.info("No attachments after filtering", {
          teamId,
          inboxId,
          messageId: MessageID,
          filteredCount: 0,
          allowedCount: allowedAttachments.length,
        });
        return c.json({ success: true });
      }

      logger.info("Filtered attachments", {
        teamId,
        inboxId,
        messageId: MessageID,
        filteredCount: filteredAttachments.length,
        allowedCount: allowedAttachments.length,
      });

      // Upload all attachments in parallel
      const uploadPromises = filteredAttachments.map((attachment) =>
        uploadAttachment(
          supabase,
          teamId,
          attachment,
          FromFull?.Email || null,
          Subject,
          MessageID,
        ),
      );

      const uploadResults = await Promise.all(uploadPromises);

      // Filter out failed uploads
      const successfulUploads = uploadResults.filter(
        (result): result is UploadResult => result !== null,
      );

      const failedUploads = uploadResults.length - successfulUploads.length;

      if (failedUploads > 0) {
        logger.warn("Some attachments failed to upload", {
          teamId,
          inboxId,
          messageId: MessageID,
          successful: successfulUploads.length,
          failed: failedUploads,
          total: uploadResults.length,
        });
      }

      if (!successfulUploads.length) {
        logger.warn("No successful uploads", {
          teamId,
          inboxId,
          messageId: MessageID,
          attempted: uploadResults.length,
        });
        return c.json({ success: true });
      }

      logger.info("Successfully uploaded attachments", {
        teamId,
        inboxId,
        messageId: MessageID,
        uploadCount: successfulUploads.length,
        failedCount: failedUploads,
      });

      // Trigger processing jobs
      await triggerProcessingJobs(teamId, successfulUploads);

      logger.info("Inbox webhook processed successfully", {
        teamId,
        inboxId,
        messageId: MessageID,
        attachmentsProcessed: successfulUploads.length,
      });

      return c.json({ success: true });
    } catch (error) {
      // Re-throw HTTPException as-is
      if (error instanceof HTTPException) {
        throw error;
      }

      // Log and wrap other errors
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.error("Inbox webhook processing failed", {
        inboxId,
        messageId: MessageID,
        error: errorMessage,
        stack: errorStack,
      });

      throw new HTTPException(500, {
        message: `Failed to process webhook for inbox_id: ${inboxId}`,
      });
    }
  },
);

export { app as inboxWebhookRouter };
