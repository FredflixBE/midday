/**
 * The version rules that are not a stored state (FF-1609). A version is
 * stored as draft, sent, superseded or accepted; expired is read from the
 * validity date every time, so it can never disagree with it.
 */

export type QuoteVersionStatus = "draft" | "sent" | "superseded" | "accepted";

/** Sent, and its validity date is behind `today` (both `YYYY-MM-DD`). */
export function isExpired(
  version: { status: QuoteVersionStatus; validUntil: string },
  today: string,
) {
  return version.status === "sent" && version.validUntil < today;
}
