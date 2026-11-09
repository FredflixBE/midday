import { expect, type Page, test } from "@playwright/test";
import { database, signedInUserId } from "./db";
import { innermost, open } from "./page";

// A settings card, by its heading and the control it holds.
function card(page: Page, heading: string, control: "combobox" | "switch") {
  return innermost(
    page.getByRole("main"),
    page.getByRole("heading", { name: heading }),
    page.getByRole(control),
  );
}

test.describe("select", () => {
  test("Appearance switches the theme", async ({ page }) => {
    await open(page, "/account");
    const theme = card(page, "Appearance", "combobox").getByRole("combobox");
    await expect(theme).toHaveText("System");

    await theme.click();
    await page.getByRole("option", { name: "dark" }).click();
    await expect(theme).toHaveText("Dark");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);

    await theme.click();
    await page.getByRole("option", { name: "light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

    // The theme lives in this browser context's storage, not the database.
    await theme.click();
    await page.getByRole("option", { name: "system" }).click();
    await expect(theme).toHaveText("System");
  });
});

test.describe("switch", () => {
  async function weekStartsOnMonday() {
    const { data, error } = await database()
      .from("users")
      .select("week_starts_on_monday")
      .eq("id", signedInUserId())
      .single();
    if (error) throw error;
    return data.week_starts_on_monday as boolean | null;
  }

  test("Start Week on Monday saves, and is put back", async ({ page }) => {
    const before = await weekStartsOnMonday();

    await open(page, "/account/date-and-locale");
    const toggle = card(page, "Start Week on Monday", "switch").getByRole(
      "switch",
    );
    await expect(toggle).toBeChecked({ checked: before === true });

    try {
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: before !== true });
      await expect.poll(weekStartsOnMonday).toBe(before !== true);

      await toggle.click();
      await expect(toggle).toBeChecked({ checked: before === true });
    } finally {
      // Put it back through the database whatever happened on screen, then
      // read it back: the screen agreeing is not proof (FF-1671).
      if ((await weekStartsOnMonday()) !== before) {
        await database()
          .from("users")
          .update({ week_starts_on_monday: before })
          .eq("id", signedInUserId());
      }
      await expect.poll(weekStartsOnMonday).toBe(before);
    }
  });
});

test.describe("tooltip", () => {
  test("hovering Synchronize names it, and leaving hides it", async ({
    page,
  }) => {
    await open(page, "/settings/accounts");
    const sync = page.getByRole("button", { name: "Synchronize" }).first();

    // A tooltip's text is not its accessible name, so find it by its text.
    const tooltip = page
      .getByText("Synchronize", { exact: true })
      .filter({ visible: true });

    await expect(tooltip).toHaveCount(0);
    await sync.hover();
    await expect(tooltip).toBeVisible();

    // Several moves, not one jump: a hoverable tooltip decides whether the
    // pointer left it on the next move after leaving the trigger.
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(tooltip).toHaveCount(0);
  });
});
