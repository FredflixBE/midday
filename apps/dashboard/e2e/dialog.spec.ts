import { expect, type Page, test } from "@playwright/test";
import { open } from "./navigate";

function focusIsOnThePage(page: Page) {
  return page.evaluate(() => {
    const focused = document.activeElement;
    return Boolean(focused?.isConnected && !focused.closest('[role="dialog"]'));
  });
}

test.describe("dialog", () => {
  test("⌘K search opens centred on every frame, and Escape closes it", async ({
    page,
  }) => {
    await open(page, "/");
    const trigger = page.getByRole("button", { name: /Find anything/ });
    await expect(trigger).toBeVisible();

    // Record the dialog's centre on every animation frame after opening,
    // since a screenshot after the animation hides a dialog that jumped
    // there (FF-1771).
    await page.evaluate(() => {
      const frames: { x: number; y: number }[] = [];
      (window as unknown as { __frames: typeof frames }).__frames = frames;
      const start = performance.now();
      const tick = () => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const box = dialog.getBoundingClientRect();
          frames.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        }
        if (performance.now() - start < 800) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.waitForTimeout(900);

    const frames = await page.evaluate(
      () =>
        (window as unknown as { __frames: { x: number; y: number }[] })
          .__frames,
    );
    expect(frames.length).toBeGreaterThan(5);
    const last = frames.at(-1)!;
    for (const frame of frames) {
      expect(Math.abs(frame.x - last.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(frame.y - last.y)).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(last.x - 1440 / 2)).toBeLessThanOrEqual(2);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Focus comes back to the page rather than staying in the closed dialog.
    // Today it lands on <body>, not on the search button.
    expect(await focusIsOnThePage(page)).toBe(true);
  });

  test("the keyboard shortcut opens search too", async ({ page }) => {
    await open(page, "/");
    await expect(
      page.getByRole("button", { name: /Find anything/ }),
    ).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});

test.describe("alert dialog", () => {
  test("Delete account asks first, and Cancel closes it", async ({ page }) => {
    await open(page, "/account");
    const card = page
      .locator("div")
      .filter({ has: page.getByRole("heading", { name: "Delete account" }) })
      .filter({ has: page.getByRole("button", { name: "Delete" }) })
      .last();

    await card.getByRole("button", { name: "Delete" }).click();

    const alert = page.getByRole("alertdialog");
    await expect(alert).toBeVisible();
    // Never confirm: this is the real account.
    await alert.getByRole("button", { name: "Cancel" }).click();
    await expect(alert).toBeHidden();
  });
});
