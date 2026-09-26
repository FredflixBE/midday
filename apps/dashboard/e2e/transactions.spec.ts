import { expect, type Page, test } from "@playwright/test";
import { open } from "./navigate";

// The body rows of the transactions table; the first row is the header.
function transactionRows(page: Page) {
  return page
    .getByRole("table")
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: "Open menu" }),
    });
}

test.beforeEach(async ({ page }) => {
  await open(page, "/transactions");
  await expect(transactionRows(page).first()).toBeVisible();
});

test.describe("sheet", () => {
  test("a transaction opens in a sheet, and Escape closes it", async ({
    page,
  }) => {
    const row = transactionRows(page).first();
    await row.getByRole("cell").nth(2).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(/transactionId=/);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/transactionId=/);
  });
});

test.describe("dropdown menu", () => {
  test("a row's actions move with the arrow keys and Enter runs one", async ({
    page,
  }) => {
    await transactionRows(page)
      .first()
      .getByRole("button", { name: "Open menu" })
      .click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const items = menu.getByRole("menuitem");

    await page.keyboard.press("ArrowDown");
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.nth(0)).toHaveText("View details");
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/transactionId=/);
  });
});

test.describe("toast", () => {
  test("copying a transaction's link says so", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await transactionRows(page)
      .first()
      .getByRole("button", { name: "Open menu" })
      .click();
    await page.getByRole("menuitem", { name: "Copy link" }).click();

    await expect(
      page.getByText("Transaction URL copied to clipboard").first(),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /\/transactions\/\?transactionId=/,
    );
  });
});

test.describe("checkbox", () => {
  test("rows can be selected one at a time and all at once", async ({
    page,
  }) => {
    const rows = transactionRows(page);
    const first = rows.first().getByRole("checkbox");

    await first.click();
    await expect(first).toBeChecked();
    await first.click();
    await expect(first).not.toBeChecked();

    const all = page.getByRole("columnheader").first().getByRole("checkbox");
    await all.click();
    await expect(all).toBeChecked();
    await expect(rows.nth(1).getByRole("checkbox")).toBeChecked();
    await all.click();
    await expect(first).not.toBeChecked();
  });
});

test.describe("tabs", () => {
  test("switching to Review selects that tab", async ({ page }) => {
    const all = page.getByRole("tab", { name: "All" });
    const review = page.getByRole("tab", { name: "Review" });
    await expect(all).toHaveAttribute("aria-selected", "true");

    await review.click();
    await expect(review).toHaveAttribute("aria-selected", "true");
    await expect(all).toHaveAttribute("aria-selected", "false");

    await all.click();
    await expect(all).toHaveAttribute("aria-selected", "true");
  });
});
