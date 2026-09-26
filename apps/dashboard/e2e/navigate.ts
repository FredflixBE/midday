import type { Page } from "@playwright/test";

/**
 * Opens a route and waits for the network to go quiet. Until the page has
 * hydrated, a click or hover reaches markup React is not listening to yet,
 * and the test fails for a reason that has nothing to do with the UI.
 */
export async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
}
