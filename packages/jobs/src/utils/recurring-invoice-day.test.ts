import { describe, expect, mock, test } from "bun:test";
import { runRecurringInvoiceDay } from "./recurring-invoice-day";

const ok = (output: unknown) => ({ ok: true as const, output });
const failed = (error: unknown) => ({ ok: false as const, error });

describe("the recurring-invoice day", () => {
  test("warns before it generates", async () => {
    const order: string[] = [];

    await runRecurringInvoiceDay(
      async () => {
        order.push("warn");
        return ok({ processed: 1 });
      },
      async () => {
        order.push("generate");
        return ok({ processed: 1 });
      },
    );

    expect(order).toEqual(["warn", "generate"]);
  });

  test("reports both halves", async () => {
    const result = await runRecurringInvoiceDay(
      async () => ok({ processed: 2 }),
      async () => ok({ processed: 1 }),
    );

    expect(result).toEqual({
      warned: { processed: 2 },
      generated: { processed: 1 },
    });
  });

  test("generates anyway when the warnings fail", async () => {
    // Invoicing is what the business depends on; a warning nobody got is not
    // a reason to skip a month.
    const generate = mock(async () => ok({ processed: 1 }));

    const result = await runRecurringInvoiceDay(
      async () => failed(new Error("notifications down")),
      generate,
    );

    expect(generate).toHaveBeenCalled();
    expect(result).toEqual({ warned: null, generated: { processed: 1 } });
  });

  test("says which half failed rather than throwing", async () => {
    const result = await runRecurringInvoiceDay(
      async () => ok({ processed: 2 }),
      async () => failed(new Error("db down")),
    );

    expect(result).toEqual({ warned: { processed: 2 }, generated: null });
  });
});
