/**
 * Which optional features this deployment actually has credentials for.
 *
 * Upstream every integration was configured, so the dashboard could show
 * every card unconditionally. A self-hosted instance runs with a handful of
 * keys, and a card whose connect button 500s is worse than no card: this is
 * the one place that decides what exists, and the dashboard asks before it
 * renders.
 */
export type FeatureAvailability = {
  assistant: boolean;
  connectors: boolean;
  enrichment: boolean;
  fortnox: boolean;
  insights: boolean;
  quickbooks: boolean;
  slack: boolean;
  stripe: boolean;
  xero: boolean;
};

function hasAll(...names: string[]): boolean {
  return names.every((name) => Boolean(process.env[name]));
}

export function getFeatureAvailability(): FeatureAvailability {
  return {
    // The chat assistant and the LLM search fallback both need OpenAI.
    assistant: hasAll("OPENAI_API_KEY"),
    // Matches isComposioConfigured() in @api/composio/client.
    connectors: hasAll("COMPOSIO_API_KEY"),
    // Matches isCompanyEnrichConfigured() in @midday/customers, which is what
    // the enrichment job checks before it stamps a status.
    enrichment: hasAll("COMPANY_ENRICH_API_KEY"),
    fortnox: hasAll("FORTNOX_CLIENT_ID", "FORTNOX_CLIENT_SECRET"),
    insights: process.env.INSIGHTS_ENABLED === "true",
    quickbooks: hasAll("QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"),
    // The connect button needs a client id; the bot itself needs the
    // signing secret, which is what isSlackConfigured() in @midday/bot checks.
    slack: hasAll(
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
    ),
    stripe: hasAll("STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID"),
    xero: hasAll("XERO_CLIENT_ID", "XERO_CLIENT_SECRET"),
  };
}
