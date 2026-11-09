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

type Versioned = { status: QuoteVersionStatus };

/** The one draft a quote may have at a time. */
export function draftVersion<V extends Versioned>(versions: V[]) {
  return versions.find((v) => v.status === "draft");
}

/**
 * The version the client holds and so the one they answer: the one sent, or
 * the one they accepted. Sending supersedes the version before it, and a won
 * quote is not sent again, so a quote has at most one.
 */
export function heldVersion<V extends Versioned>(versions: V[]) {
  return versions.find((v) => v.status === "sent" || v.status === "accepted");
}

/** The version the client said yes to, when they did. */
export function acceptedVersion<V extends Versioned>(versions: V[]) {
  return versions.find((v) => v.status === "accepted");
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
