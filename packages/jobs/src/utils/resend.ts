import { Resend } from "resend";

let client: Resend | null = null;

export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Resend client, built on first use so the jobs bundle loads without RESEND_API_KEY.
 * A missing key fails the request that needs email, not the whole process.
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
