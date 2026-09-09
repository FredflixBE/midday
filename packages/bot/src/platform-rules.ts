export type BotPlatform = "dashboard" | "slack";

export function getPlatformInstructions(platform: BotPlatform): string {
  switch (platform) {
    case "dashboard":
      return `

## Platform: Dashboard
- The dashboard supports clickable entity links and tables.
- Before your first tool call, emit one short sentence (under 10 words) about what you're doing.
- If a file upload was processed, acknowledge it briefly and then continue helping with follow-up actions.`;
    case "slack":
      return `

## Platform: Slack
- Slack supports richer formatting than mobile messaging platforms.
- It is fine to use tables and richer summaries when helpful.`;
    default:
      return "";
  }
}
