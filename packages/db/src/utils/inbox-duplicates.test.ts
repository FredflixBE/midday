import { describe, expect, test } from "bun:test";
import {
  type InvoiceCopy,
  invoiceIdentity,
  planInvoiceCopies,
} from "./inbox-duplicates";

function copy(overrides: Partial<InvoiceCopy> & { id: string }): InvoiceCopy {
  return {
    invoiceNumber: "5664449825",
    amount: 39,
    currency: "EUR",
    displayName: "Google Cloud EMEA Limited",
    type: "invoice",
    referenceId: `sha256-${overrides.id}`,
    transactionId: null,
    hasConfirmedMatch: false,
    groupedInboxId: null,
    createdAt: "2026-09-12T16:00:00Z",
    ...overrides,
  };
}

describe("invoiceIdentity", () => {
  test("two PDFs of one invoice share an identity", () => {
    const a = copy({ id: "a" });
    const b = copy({
      id: "b",
      invoiceNumber: " 5664449825 ",
      displayName: "google cloud emea limited",
      currency: "eur",
      amount: 39.0,
    });
    expect(invoiceIdentity(a)).not.toBeNull();
    expect(invoiceIdentity(a)).toBe(invoiceIdentity(b));
  });

  test("spacing inside an invoice number does not make a different invoice", () => {
    expect(
      invoiceIdentity(copy({ id: "a", invoiceNumber: "SBIE-12857967" })),
    ).toBe(
      invoiceIdentity(copy({ id: "b", invoiceNumber: "sbie - 12857967" })),
    );
  });

  test("a different amount, currency, supplier or type is a different document", () => {
    const base = invoiceIdentity(copy({ id: "a" }));
    expect(invoiceIdentity(copy({ id: "b", amount: 41.59 }))).not.toBe(base);
    expect(invoiceIdentity(copy({ id: "c", currency: "USD" }))).not.toBe(base);
    expect(invoiceIdentity(copy({ id: "d", displayName: "Adobe" }))).not.toBe(
      base,
    );
    expect(invoiceIdentity(copy({ id: "e", type: "expense" }))).not.toBe(base);
  });

  test("without a number, an amount or a supplier there is no identity to compare", () => {
    expect(invoiceIdentity(copy({ id: "a", invoiceNumber: null }))).toBeNull();
    expect(invoiceIdentity(copy({ id: "b", invoiceNumber: "  " }))).toBeNull();
    expect(invoiceIdentity(copy({ id: "c", amount: null }))).toBeNull();
    expect(invoiceIdentity(copy({ id: "d", displayName: null }))).toBeNull();
    expect(invoiceIdentity(copy({ id: "e", currency: null }))).toBeNull();
  });
});

describe("planInvoiceCopies", () => {
  test("keeps the oldest email copy and removes the newer one", () => {
    const older = copy({ id: "older", createdAt: "2026-09-12T16:00:00Z" });
    const newer = copy({ id: "newer", createdAt: "2026-09-12T16:00:05Z" });
    const plan = planInvoiceCopies([newer, older]);
    expect(plan.keep.id).toBe("older");
    expect(plan.remove.map((row) => row.id)).toEqual(["newer"]);
  });

  test("gives the same answer whichever copy asks, so two runs at once agree", () => {
    const a = copy({ id: "a", createdAt: "2026-09-20T12:58:54Z" });
    const b = copy({ id: "b", createdAt: "2026-09-20T12:58:54Z" });
    expect(planInvoiceCopies([a, b]).keep.id).toBe(
      planInvoiceCopies([b, a]).keep.id,
    );
  });

  test("the copy already in use survives, even when it is the newer one", () => {
    const older = copy({ id: "older", createdAt: "2026-09-01T00:00:00Z" });
    const matched = copy({
      id: "matched",
      createdAt: "2026-09-02T00:00:00Z",
      transactionId: "tx-1",
    });
    const plan = planInvoiceCopies([older, matched]);
    expect(plan.keep.id).toBe("matched");
    expect(plan.remove.map((row) => row.id)).toEqual(["older"]);
  });

  test("a confirmed match counts as in use", () => {
    const older = copy({ id: "older", createdAt: "2026-09-01T00:00:00Z" });
    const confirmed = copy({
      id: "confirmed",
      createdAt: "2026-09-02T00:00:00Z",
      hasConfirmedMatch: true,
    });
    expect(planInvoiceCopies([older, confirmed]).keep.id).toBe("confirmed");
  });

  test("never removes a copy that is in use, even a second one", () => {
    const one = copy({ id: "one", transactionId: "tx-1" });
    const two = copy({
      id: "two",
      hasConfirmedMatch: true,
      createdAt: "2026-09-13T00:00:00Z",
    });
    const spare = copy({ id: "spare", createdAt: "2026-09-14T00:00:00Z" });
    const plan = planInvoiceCopies([one, two, spare]);
    expect(plan.remove.map((row) => row.id)).toEqual(["spare"]);
  });

  test("never removes the copy that came from the books, and keeps one email copy beside it", () => {
    const books = copy({
      id: "books",
      referenceId: "yuki:4ad0b24e",
      createdAt: "2026-09-01T00:00:00Z",
    });
    const email = copy({ id: "email", createdAt: "2026-09-12T00:00:00Z" });
    const extra = copy({ id: "extra", createdAt: "2026-09-12T00:00:01Z" });
    const plan = planInvoiceCopies([books, email, extra]);
    expect(plan.keep.id).toBe("email");
    expect(plan.remove.map((row) => row.id)).toEqual(["extra"]);
  });

  test("prefers the copy the inbox already shows over an older one nested under it", () => {
    const nested = copy({
      id: "nested",
      createdAt: "2026-09-01T00:00:00Z",
      groupedInboxId: "shown",
    });
    const shown = copy({ id: "shown", createdAt: "2026-09-02T00:00:00Z" });
    expect(planInvoiceCopies([nested, shown]).keep.id).toBe("shown");
  });

  test("one copy alone has nothing to remove", () => {
    const only = copy({ id: "only" });
    expect(planInvoiceCopies([only])).toEqual({ keep: only, remove: [] });
  });
});
