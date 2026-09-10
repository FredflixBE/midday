import { beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod/v4";
import type { receiptConfig } from "../config/extraction-config";
import { MAX_PARALLEL_FIELD_REEXTRACTIONS } from "./base-extraction-engine";
import { ReceiptProcessor } from "./receipt/receipt-processor";

type ReceiptData = z.infer<typeof receiptConfig.schema>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A receipt the model found nothing on: every field null, which is what a
 * photo of something that is not a receipt produces.
 */
function emptyReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    document_type: "receipt",
    date: null,
    currency: null,
    total_amount: null,
    subtotal_amount: null,
    tax_amount: null,
    tax_type: null,
    store_name: null,
    website: null,
    payment_method: null,
    items: [],
    cashier_name: null,
    email: null,
    register_number: null,
    language: null,
    ...overrides,
  };
}

/**
 * The engine with both of its model seams replaced: whole-document passes
 * answer from a script, and single-field re-extraction answers from a map.
 * What the tests read back is how many calls each one took, and how many of
 * the field calls were in the air at the same time.
 */
class ScriptedReceiptProcessor extends ReceiptProcessor {
  passResponses: ReceiptData[] = [];
  fieldValues: Record<string, unknown> = {};

  passCount = 0;
  fieldCalls: string[] = [];
  peakParallelFieldCalls = 0;
  #fieldCallsInFlight = 0;

  protected override async extractWithProvider(): Promise<ReceiptData> {
    const response = this.passResponses[this.passCount];
    this.passCount += 1;

    if (!response) {
      throw new Error(`No scripted response for pass ${this.passCount}`);
    }

    return response;
  }

  protected override async reExtractField(
    _documentUrl: string,
    field: string,
  ): Promise<{ field: string; value: unknown } | null> {
    this.fieldCalls.push(field);
    this.#fieldCallsInFlight += 1;
    this.peakParallelFieldCalls = Math.max(
      this.peakParallelFieldCalls,
      this.#fieldCallsInFlight,
    );

    await sleep(5);
    this.#fieldCallsInFlight -= 1;

    const value = this.fieldValues[field];
    return value === undefined ? null : { field, value };
  }
}

describe("extraction escalation", () => {
  let processor: ScriptedReceiptProcessor;

  beforeEach(() => {
    processor = new ScriptedReceiptProcessor();
  });

  test("stops at Pass 1 when the model says the document is not financial", async () => {
    processor.passResponses = [emptyReceipt({ document_type: "other" })];

    const result = await processor.extract("https://example.com/photo.jpg");

    expect(processor.passCount).toBe(1);
    expect(processor.fieldCalls).toEqual([]);
    expect(result.data.document_type).toBe("other");
  });

  test("stops before Pass 3 when two passes found nothing at all", async () => {
    processor.passResponses = [emptyReceipt(), emptyReceipt()];

    await processor.extract("https://example.com/photo.jpg");

    expect(processor.passCount).toBe(2);
    expect(processor.fieldCalls).toEqual([]);
  });

  test("still escalates when a pass recovered something", async () => {
    processor.passResponses = [
      emptyReceipt(),
      emptyReceipt({ store_name: "Coffee Bar" }),
    ];

    await processor.extract("https://example.com/receipt.jpg");

    expect(processor.passCount).toBe(2);
    expect(processor.fieldCalls.sort()).toEqual([
      "currency",
      "date",
      "tax_amount",
      "total_amount",
    ]);
  });

  test("never has more than the bound of field re-extractions in flight", async () => {
    processor.passResponses = [
      emptyReceipt(),
      emptyReceipt({ store_name: "Coffee Bar" }),
    ];

    await processor.extract("https://example.com/receipt.jpg");

    expect(processor.peakParallelFieldCalls).toBeLessThanOrEqual(
      MAX_PARALLEL_FIELD_REEXTRACTIONS,
    );
    expect(processor.peakParallelFieldCalls).toBeGreaterThan(0);
  });

  test("merges what the field re-extractions recovered", async () => {
    processor.passResponses = [
      emptyReceipt(),
      emptyReceipt({ store_name: "Coffee Bar" }),
    ];
    processor.fieldValues = { total_amount: 42, currency: "EUR" };

    const result = await processor.extract("https://example.com/receipt.jpg");

    expect(result.data.total_amount).toBe(42);
    expect(result.data.currency).toBe("EUR");
    expect(result.data.store_name).toBe("Coffee Bar");
  });
});
