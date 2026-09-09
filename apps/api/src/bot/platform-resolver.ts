import {
  PlatformIdentityAlreadyLinkedToAnotherTeamError,
  PlatformIdentityAlreadyLinkedToAnotherUserError,
} from "@midday/db/errors";

export function mapPlatformLinkError(
  error: unknown,
  displayName: string,
): string | null {
  if (error instanceof PlatformIdentityAlreadyLinkedToAnotherUserError) {
    return `This ${displayName} is already linked to another Midday user.`;
  }

  if (error instanceof PlatformIdentityAlreadyLinkedToAnotherTeamError) {
    return `This ${displayName} is already linked to another Midday workspace.`;
  }

  return null;
}

const SLACK_WELCOME = {
  capabilities:
    "You can ask Midday questions, upload receipts, and track invoices right from Slack.",
  notifications: "new transactions, invoices, and match suggestions",
  settingsLabel: "Slack",
  callToAction: "Try asking \u201cWhat's my cash flow this month?\u201d",
};

export function buildWelcomeMessage(teamName: string): string {
  return (
    `Connected to ${teamName}. ${SLACK_WELCOME.capabilities}\n\n` +
    `You'll receive notifications for ${SLACK_WELCOME.notifications} (all on by default). ` +
    `To manage these, go to Apps \u2192 ${SLACK_WELCOME.settingsLabel} \u2192 Settings in Midday.\n\n` +
    SLACK_WELCOME.callToAction
  );
}
