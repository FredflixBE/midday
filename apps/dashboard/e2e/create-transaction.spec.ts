import { expect, type Page, test } from "@playwright/test";
import { innermost, open } from "./page";

// Every test here fills the "Create transaction" form without ever saving it.
// Should one submit a valid form by mistake, the request is stopped before it
// leaves the browser, and the test fails rather than writing a transaction.
let triedToCreate = false;

test.beforeEach(async ({ page }) => {
  triedToCreate = false;
  await page.route(/\/trpc\/.*transactions\.create/, async (route) => {
    triedToCreate = true;
    await route.abort();
  });

  await open(page, "/transactions?createTransaction=true");
  await expect(form(page).getByLabel("Description")).toBeVisible();
});

test.afterEach(() => {
  expect(triedToCreate, "a test submitted a valid transaction").toBe(false);
});

function form(page: Page) {
  return page.getByRole("dialog");
}

// A form field whose label is not tied to its control.
function field(page: Page, label: string) {
  return innermost(
    form(page),
    page.getByText(label, { exact: true }),
    page.getByRole("button"),
  );
}

test.describe("popover", () => {
  test("the date picker opens a calendar and a picked day closes it", async ({
    page,
  }) => {
    const date = form(page).getByLabel("Date");
    const before = await date.innerText();

    await date.click();
    const calendar = page.getByRole("grid");
    await expect(calendar).toBeVisible();

    // Pick the first of the month shown, which is never in the future. Days
    // from the month before come first, but none of them is a 1st.
    await calendar
      .getByRole("button", { name: /\b1st\b/ })
      .first()
      .click();
    await expect(calendar).toBeHidden();
    await expect(date).toHaveText(/^01\//);
    expect(before).not.toBe("");
  });
});

test.describe("combobox", () => {
  test("typing filters the currencies and a pick sets it", async ({ page }) => {
    const currency = field(page, "Currency").getByRole("button");
    await currency.click();

    const search = page.getByPlaceholder("Search currencies");
    await expect(search).toBeFocused();
    await search.fill("us");

    const options = page.getByRole("option");
    await expect(options.filter({ hasText: "USD" })).toBeVisible();
    await expect(options.filter({ hasText: "EUR" })).toHaveCount(0);

    await options.filter({ hasText: "USD" }).click();
    await expect(search).toBeHidden();
    await expect(currency).toHaveText("USD");
  });
});

test.describe("accordion", () => {
  test("Note expands to a text field and collapses again", async ({ page }) => {
    const note = form(page).getByRole("button", { name: "Note" });
    const field = form(page).getByPlaceholder("Note");

    await expect(note).toHaveAttribute("aria-expanded", "false");
    await expect(field).toBeHidden();

    await note.click();
    await expect(note).toHaveAttribute("aria-expanded", "true");
    await expect(field).toBeVisible();

    await note.click();
    await expect(field).toBeHidden();
  });
});

test.describe("switch and form", () => {
  test("the switch toggles, and submitting it empty shows the errors", async ({
    page,
  }) => {
    const exclude = form(page).getByRole("switch");
    await exclude.click();
    await expect(exclude).toBeChecked();
    await exclude.click();
    await expect(exclude).not.toBeChecked();

    await form(page).getByRole("button", { name: "Create" }).click();

    // Description and amount are both empty, so both say so.
    await expect(form(page).getByText("Required", { exact: true })).toHaveCount(
      2,
    );
    for (const label of ["Description", "Amount"]) {
      await expect(form(page).getByLabel(label)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    }
  });
});
