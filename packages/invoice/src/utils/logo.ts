import { isAllowedAssetUrl } from "@midday/utils/asset-hosts";

export async function isValidLogoUrl(url: string): Promise<boolean> {
  if (!url) return false;

  // SSRF protection: only fetch from hosts this deployment owns.
  if (!isAllowedAssetUrl(url)) return false;

  try {
    // Use HEAD to avoid fetching body, with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}
