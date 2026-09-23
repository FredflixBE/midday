import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDesktopScheme } from "./scheme";

export function isDesktopApp() {
  return isTauri();
}

/**
 * Returns the deep link base URL (scheme + "://") for the current environment.
 *
 * @example
 * getDesktopSchemeUrl() // "hq://" in production, "hq-dev://" in dev
 */
export function getDesktopSchemeUrl(): string {
  return `${getDesktopScheme()}://`;
}

export type DeepLinkHandler = (path: string) => void;

export async function listenForDeepLinks(handler: DeepLinkHandler) {
  if (!isDesktopApp()) {
    console.log("Deep links are only available in desktop app");
    return () => {}; // No-op cleanup for non-desktop environments
  }

  try {
    const unlisten = await listen<string>("deep-link-navigate", (event) => {
      console.log("Deep link navigation received:", event.payload);
      handler(event.payload);
    });

    console.log("Deep link listener registered");
    return unlisten;
  } catch (error) {
    console.error("Failed to listen for deep links:", error);
    return () => {};
  }
}

/**
 * Generate a deep link URL for the current environment.
 * @param path The path to navigate to (without leading slash)
 * @returns The deep link URL
 *
 * @example
 * ```typescript
 * // In production:
 * createDeepLink('dashboard');           // "hq://dashboard"
 * // In dev:
 * createDeepLink('transactions/123');    // "hq-dev://transactions/123"
 * ```
 */
export function createDeepLink(path: string): string {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${getDesktopSchemeUrl()}${cleanPath}`;
}
