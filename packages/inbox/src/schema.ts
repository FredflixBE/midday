import { z } from "zod/v3";

export const inboxAttachment = z
  .object({
    Name: z.string(),
    Content: z.string(),
    ContentType: z.string(),
    ContentID: z.string(),
    ContentLength: z.number(),
  })
  .passthrough();

export const inboxWebhookPostSchema = z
  .object({
    // The domain is checked against INBOX_FORWARDING_DOMAIN in the route,
    // which is the only place that knows what this deployment accepts.
    OriginalRecipient: z
      .string({ required_error: "OriginalRecipient is required" })
      .email({ message: "Invalid email format" }),
    Attachments: z.array(inboxAttachment).optional(),
    Subject: z.string().optional(),
    TextBody: z.string().optional(),
    HtmlBody: z.string().optional(),
    FromFull: z
      .object({
        Name: z.string(),
        Email: z.string(),
      })
      .passthrough(),
    MessageID: z.string({ required_error: "MessageID is required" }),
  })
  .passthrough();
