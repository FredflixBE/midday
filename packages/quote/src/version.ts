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

export type QuoteOutcome = "open" | "won" | "lost" | "no_decision";

/**
 * The one word a quote's state is shown as (FF-1614): an answer recorded on
 * the quote wins over its version's status, and a sent version past its
 * validity reads as expired — so does a revision drafted while the version
 * the client holds has lapsed. The dashboard and the MCP tools both say it.
 */
export function quoteState(
  quote: { outcome: QuoteOutcome },
  version: { status: QuoteVersionStatus; expired: boolean },
  held?: { expired: boolean } | null,
) {
  if (quote.outcome === "won") return "Won";
  if (quote.outcome === "lost") return "Lost";
  if (quote.outcome === "no_decision") return "No decision";
  if (version.expired) return "Expired";
  if (version.status === "draft" && held?.expired) return "Draft · expired";
  return {
    draft: "Draft",
    sent: "Sent",
    superseded: "Superseded",
    accepted: "Accepted",
  }[version.status];
}
