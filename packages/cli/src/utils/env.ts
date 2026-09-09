export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function isCI(): boolean {
  return Boolean(
    process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI,
  );
}

export function hasNoColor(): boolean {
  return Boolean(process.env.NO_COLOR);
}

export function isAgentMode(flags: {
  json?: boolean;
  agent?: boolean;
  quiet?: boolean;
}): boolean {
  if (flags.agent || flags.json) return true;
  if (!isTTY()) return true;
  return false;
}

export function shouldShowUI(flags: {
  json?: boolean;
  agent?: boolean;
  quiet?: boolean;
}): boolean {
  if (flags.quiet || flags.agent || flags.json) return false;
  if (!isTTY()) return false;
  if (isCI()) return false;
  return true;
}

/**
 * The instance this CLI talks to. There is no default: the CLI ships to
 * whoever self-hosts, and guessing a host would point their API keys at
 * somebody else's deployment.
 */
export function getApiUrl(): string {
  const apiUrl = process.env.MIDDAY_API_URL;

  if (!apiUrl) {
    throw new Error(
      "MIDDAY_API_URL is not set. Set it to the URL of your Midday API, e.g. https://api.midday.example.com",
    );
  }

  return apiUrl.replace(/\/+$/, "");
}

/** Where the browser is sent for the OAuth consent step. */
export function getDashboardUrl(): string {
  const dashboardUrl = process.env.MIDDAY_DASHBOARD_URL;

  if (!dashboardUrl) {
    throw new Error(
      "MIDDAY_DASHBOARD_URL is not set. Set it to the URL of your Midday dashboard, e.g. https://midday.example.com",
    );
  }

  return dashboardUrl.replace(/\/+$/, "");
}
