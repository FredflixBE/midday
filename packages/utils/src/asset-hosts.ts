import { getApiUrl, getAppUrl, getCdnUrl } from "./envs";

/**
 * The hosts this deployment will fetch a user-supplied image from.
 *
 * These checks are SSRF guards, not branding: a logo URL is fetched
 * server-side when an invoice PDF or an OG image is rendered, so accepting an
 * arbitrary host would let anyone point the renderer at an internal address.
 * Upstream hardcoded Midday's own domains, which rejects a self-hoster's own
 * uploads; the list is derived from this deployment's URLs instead.
 *
 * `ALLOWED_ASSET_HOSTS` (comma-separated hostnames) covers anything else you
 * host images on.
 */
function hostOf(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Reading a URL helper throws when it is unset; an absent host just cannot match. */
function safeHost(read: () => string): string | null {
  try {
    return hostOf(read());
  } catch {
    return null;
  }
}

export function getAllowedAssetHosts(): Set<string> {
  const hosts = [
    // Storage: avatars, team logos and vault files live in Supabase.
    hostOf(process.env.SUPABASE_URL),
    hostOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
    // This deployment's own surfaces.
    safeHost(getCdnUrl),
    safeHost(getAppUrl),
    safeHost(getApiUrl),
    ...(process.env.ALLOWED_ASSET_HOSTS?.split(",") ?? []).map((entry) =>
      entry.trim().toLowerCase(),
    ),
  ];

  return new Set(hosts.filter((host): host is string => Boolean(host)));
}

/**
 * Whether an image URL is one this deployment is willing to fetch.
 * Only http(s) is accepted, so `file:` and `data:` can never slip through.
 */
export function isAllowedAssetUrl(url: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    return getAllowedAssetHosts().has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
