import { expect, type Page, test } from "@playwright/test";
import { innermost, open } from "./page";

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

    // Record the dialog's centre on every animation frame for 600 ms from the
    // frame it appears, since a screenshot after the animation hides a dialog
    // that jumped there (FF-1771).
    await page.evaluate(() => {
      const recording = {
        frames: [] as { x: number; y: number }[],
        done: false,
      };
      (window as unknown as { __recording: typeof recording }).__recording =
        recording;
      let start: number | undefined;
      const tick = (now: number) => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          start ??= now;
          const box = dialog.getBoundingClientRect();
          recording.frames.push({
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
        }
        if (start === undefined || now - start < 600) {
          requestAnimationFrame(tick);
        } else {
          recording.done = true;
        }
      };
      requestAnimationFrame(tick);
    });

    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();

    const recording = await page.waitForFunction(() => {
      const { __recording } = window as unknown as {
        __recording: { frames: { x: number; y: number }[]; done: boolean };
      };
      return __recording.done && __recording.frames;
    });
    const frames = (await recording.jsonValue()) as { x: number; y: number }[];

    expect(frames.length).toBeGreaterThan(5);
    const last = frames.at(-1)!;
    for (const frame of frames) {
      expect(Math.abs(frame.x - last.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(frame.y - last.y)).toBeLessThanOrEqual(2);
    }
    const viewport = page.viewportSize()!;
    expect(Math.abs(last.x - viewport.width / 2)).toBeLessThanOrEqual(2);

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
    const deleteButton = page.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    const card = innermost(
      page.getByRole("main"),
      page.getByRole("heading", { name: "Delete account" }),
      deleteButton,
    );

    await card.getByRole("button", { name: "Delete", exact: true }).click();

    const alert = page.getByRole("alertdialog");
    await expect(alert).toBeVisible();
    // Never confirm: this is the real account.
    await alert.getByRole("button", { name: "Cancel" }).click();
    await expect(alert).toBeHidden();
  });
});
