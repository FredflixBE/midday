import type { RouterOutputs } from "@api/trpc/routers/_app";

type Quote = RouterOutputs["quotes"]["get"];
type Version = Quote["versions"][number];

/**
 * The one word a quote's state is shown as (FF-1614): an answer recorded on
 * the quote wins over its version's status, and a sent version past its
 * validity reads as expired — so does a revision drafted while the version
 * the client holds has lapsed.
 */
export function quoteState(
  quote: Pick<Quote, "outcome">,
  version: Pick<Version, "status" | "expired">,
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
