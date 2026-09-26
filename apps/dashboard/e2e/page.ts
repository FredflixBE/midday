import type { Locator, Page } from "@playwright/test";

/**
 * Opens a route and waits for the network to go quiet. Until the page has
 * hydrated, a click or hover reaches markup React is not listening to yet,
 * and the test fails for a reason that has nothing to do with the UI.
 */
export async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
}

/**
 * The innermost block inside `scope` that holds every one of `parts`: a
 * settings card by its heading and control, or a form field whose label is
 * not tied to its input. Roles and text only, so it survives the markup
 * changing underneath.
 */
export function innermost(scope: Locator, ...parts: Locator[]) {
  return parts
    .reduce(
      (blocks, part) => blocks.filter({ has: part }),
      scope.locator("div"),
    )
    .last();
}
