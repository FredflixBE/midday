/**
 * The one word a quote's state is shown as (FF-1614): an answer recorded on
 * the quote wins over its version's status, and a sent version past its
 * validity reads as expired.
 */
export function quoteState(
  quote: { outcome: "open" | "won" | "lost" | "no_decision" },
  version: {
    status: "draft" | "sent" | "superseded" | "accepted";
    expired: boolean;
  },
) {
  if (quote.outcome === "won") return "Won";
  if (quote.outcome === "lost") return "Lost";
  if (quote.outcome === "no_decision") return "No decision";
  if (version.expired) return "Expired";
  return {
    draft: "Draft",
    sent: "Sent",
    superseded: "Superseded",
    accepted: "Accepted",
  }[version.status];
}
