/**
 * Where an inbox row keeps the reason its processing was refused, in `meta`.
 *
 * Only a reason worth showing whoever uploaded the file goes here — one they
 * can act on, like a photo with more pixels than we can convert. A failure
 * with nothing useful to say leaves it empty, and the inbox falls back to its
 * generic message.
 */
export const INBOX_FAILURE_REASON_KEY = "failureReason";

/** The reason an inbox row's processing was refused, if it recorded one. */
export function getInboxFailureReason(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") {
    return null;
  }

  const reason = (meta as Record<string, unknown>)[INBOX_FAILURE_REASON_KEY];

  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}
