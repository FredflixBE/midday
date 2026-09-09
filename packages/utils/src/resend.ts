import { Resend } from "resend";

let client: Resend | null = null;

/**
 * Whether this instance can send email at all. Call it before offering an
 * email-backed feature; a self-hosted instance may run without Resend.
 */
export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * The shared Resend client, built on first use so that importing a module
 * which sends email does not require RESEND_API_KEY at boot. A missing key
 * fails the request or task that needs email, not the whole process.
 */
export function getResend(): Resend {
  if (client) {
    return client;
  }

  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set: email sending is unavailable on this instance",
    );
  }

  client = new Resend(apiKey);

  return client;
}
