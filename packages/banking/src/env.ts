import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Banking package environment.
 *
 * Validated on first import, so only Enable Banking is required: it is the
 * one provider a self-hosted install must have. GoCardless is optional; check
 * `isGoCardlessConfigured()` before using it.
 */
export const env = createEnv({
  server: {
    ENABLEBANKING_APPLICATION_ID: z.string().min(1),
    ENABLE_BANKING_KEY_CONTENT: z.string().min(1),
    ENABLEBANKING_REDIRECT_URL: z.string().min(1),
    GOCARDLESS_SECRET_ID: z.string().min(1).optional(),
    GOCARDLESS_SECRET_KEY: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export function isGoCardlessConfigured(): boolean {
  return Boolean(env.GOCARDLESS_SECRET_ID && env.GOCARDLESS_SECRET_KEY);
}
