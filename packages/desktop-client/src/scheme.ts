/**
 * Returns the deep link scheme of the desktop build the dashboard talks to.
 * Controlled by NEXT_PUBLIC_DESKTOP_SCHEME; it must match the `deep-link`
 * schemes in the desktop app's Tauri config.
 *
 * - Production: "hq"
 * - Dev:        "hq-dev"
 *
 * Kept free of Tauri imports so server routes can read it too.
 */
export function getDesktopScheme(): string {
  return process.env.NEXT_PUBLIC_DESKTOP_SCHEME || "hq";
}
