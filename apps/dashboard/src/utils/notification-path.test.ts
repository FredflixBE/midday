import { describe, expect, test } from "bun:test";
import { notificationPath } from "./notification-path";

describe("notificationPath", () => {
  test("an invoice activity opens that invoice", () => {
    expect(notificationPath("invoice_paid", { recordId: "inv-1" })).toBe(
      "/invoices?invoiceId=inv-1&invoiceType=details",
    );
    expect(notificationPath("invoice_overdue", { recordId: "inv-2" })).toBe(
      "/invoices?invoiceId=inv-2&invoiceType=details",
    );
  });

  test("one new transaction opens it; a batch opens its date range", () => {
    expect(notificationPath("transactions_created", { recordId: "tx-1" })).toBe(
      "/transactions?transactionId=tx-1",
    );
    expect(
      notificationPath("transactions_created", {
        dateRange: { from: "2026-09-01", to: "2026-09-25" },
      }),
    ).toBe("/transactions?start=2026-09-01&end=2026-09-25");
    expect(notificationPath("transactions_created", {})).toBe("/transactions");
  });

  test("an inbox item opens it, or the inbox without one", () => {
    expect(notificationPath("inbox_new", { totalCount: 3 })).toBe("/inbox");
    expect(notificationPath("inbox_auto_matched", { inboxId: "in-1" })).toBe(
      "/inbox?inboxId=in-1&inboxType=details",
    );
    expect(notificationPath("inbox_needs_review", {})).toBe("/inbox");
  });

  test("a recurring series opens its invoice, or the series", () => {
    expect(
      notificationPath("recurring_series_started", {
        invoiceId: "inv-3",
        recordId: "rec-1",
      }),
    ).toBe("/invoices?invoiceId=inv-3&invoiceType=details");
    expect(
      notificationPath("recurring_series_completed", { recordId: "rec-1" }),
    ).toBe("/invoices?editRecurringId=rec-1");
    expect(
      notificationPath("recurring_invoice_upcoming", { recordId: "rec-2" }),
    ).toBe("/invoices?editRecurringId=rec-2");
  });

  test("ids are encoded", () => {
    expect(notificationPath("invoice_paid", { recordId: "a&b" })).toBe(
      "/invoices?invoiceId=a%26b&invoiceType=details",
    );
  });

  test("anything else opens the overview", () => {
    expect(notificationPath("document_uploaded", {})).toBe("/");
    expect(notificationPath("invoice_paid", {})).toBe("/invoices");
  });
});
