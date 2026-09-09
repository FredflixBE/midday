/**
 * The URLs of this deployment, read from the environment in one place.
 *
 * There is deliberately no hosted fallback. An unset URL in production is a
 * misconfiguration, and throwing on the first read is far cheaper than
 * silently pointing a self-hosted instance — its emails, OAuth redirects and
 * customer-facing invoice links — at somebody else's production. Outside
 * production the local development ports stand in, so `bun run dev` needs no
 * environment at all.
 */

function required(
  name: string,
  value: string | undefined,
  devFallback: string,
) {
  if (value) {
    // A trailing slash would double up in every `${url}/path` template.
    return value.replace(/\/+$/, "");
  }

  if (process.env.NODE_ENV !== "production") {
    return devFallback;
  }

  throw new Error(
    `${name} is not set. Set it to the public URL of this deployment; see SELF_HOSTING.md.`,
  );
}

/** Public URL of the dashboard, e.g. https://midday.example.com. */
export function getAppUrl() {
  return required(
    "DASHBOARD_URL",
    // NEXT_PUBLIC_URL is the dashboard's own name for the same value.
    process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_URL,
    "http://localhost:3001",
  );
}

/** Public URL of the API, e.g. https://api.midday.example.com. */
export function getApiUrl() {
  return required(
    "API_URL",
    process.env.API_URL || process.env.NEXT_PUBLIC_API_URL,
    "http://localhost:3003",
  );
}

/**
 * Where the images an email references are served from. Emails are read long
 * after they are sent and by clients that will not authenticate, so this has
 * to be publicly reachable; it defaults to the dashboard, which serves
 * `/email/*` from its public directory.
 */
export function getEmailUrl() {
  return process.env.EMAIL_ASSETS_URL?.replace(/\/+$/, "") || getAppUrl();
}

/** Host for static assets. Defaults to serving them from the dashboard. */
export function getCdnUrl() {
  return process.env.CDN_URL?.replace(/\/+$/, "") || getAppUrl();
}
