// Whether this desktop app shows new notifications natively. Kept on the
// device rather than the account: it is this machine's app that shows them,
// and a browser tab on another machine has no say.
const STORAGE_KEY = "desktop-notifications";

export function desktopNotificationsEnabled() {
  return localStorage.getItem(STORAGE_KEY) === "on";
}

export function setDesktopNotificationsEnabled(enabled: boolean) {
  if (enabled) {
    localStorage.setItem(STORAGE_KEY, "on");
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Hands `text` to the desktop shell as a native notification; clicking it
 * opens `path`. Loaded on use so web pages do not ship the desktop APIs
 * (FF-1725).
 */
export function showOnDesktop(
  text: string,
  path: string,
  options?: { evenInForeground?: boolean },
) {
  import("@midday/desktop-client/core")
    .then(({ showDesktopNotification }) =>
      showDesktopNotification(text, path, options),
    )
    .catch((error: unknown) => {
      console.error("Failed to show a desktop notification", error);
    });
}
