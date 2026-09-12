import { z } from "@hono/zod-openapi";
import { YUKI_REGIONS } from "@midday/yuki";

export const disconnectAppSchema = z.object({
  appId: z.string(),
});

export const updateAppSettingsSchema = z.object({
  appId: z.string(),
  option: z.object({
    id: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
});

export const createPlatformLinkTokenSchema = z.object({
  provider: z.enum(["slack"]),
});

const yukiCredentialsSchema = z.object({
  accessKey: z.string().trim().min(1, "Paste the access key from Yuki."),
  region: z.enum(YUKI_REGIONS),
});

export const verifyYukiSchema = yukiCredentialsSchema;

export const connectYukiSchema = yukiCredentialsSchema.extend({
  administrationId: z.string().min(1),
});

export const connectYukiCardSchema = z.object({
  /** The GL account code of the card in Yuki, e.g. "434001". */
  glAccountCode: z.string().trim().min(1),
});
