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

  /** How long a single scripted field call takes. */
  fieldCallDuration = 5;

  limitPass3To(milliseconds: number) {
    this.fieldReExtractionBudget = milliseconds;
  }

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

    await sleep(this.fieldCallDuration);
    this.#fieldCallsInFlight -= 1;

    const value = this.fieldValues[field];
    return value === undefined ? null : { field, value };
  }
}

/**
 * The same engine with only the provider seam replaced, so the options the
 * field batches pass down are the ones under test rather than stubbed over.
 */
class ProviderRecordingProcessor extends ReceiptProcessor {
  passResponses: ReceiptData[] = [];
  fieldResponse: ReceiptData = emptyReceipt();
  providerCalls: Array<{
    model: string;
    options: { timeout?: number; retries?: number; retryDelay?: number };
  }> = [];

  protected override async extractWithProvider(
    _documentUrl: string,
    _prompt: string,
    modelConfig: { provider: string; model: string },
    options: {
      timeout?: number;
      retries?: number;
      retryDelay?: number;
    } = {},
  ): Promise<ReceiptData> {
    this.providerCalls.push({ model: modelConfig.model, options });

    // The whole-document passes come first; everything after is Pass 3 asking
    // for one field at a time.
    const response = this.passResponses[this.providerCalls.length - 1];
    return response ?? this.fieldResponse;
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

  test("keeps escalating when the first model says other but read an amount", async () => {
    processor.passResponses = [
      emptyReceipt({ document_type: "other", total_amount: 20 }),
      emptyReceipt({ document_type: "other", total_amount: 20 }),
    ];

    await processor.extract("https://example.com/invoice.jpg");

    // The smallest of the three models does not get to end the extraction on
    // its own when it has read something off the page.
    expect(processor.passCount).toBe(2);
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

    // Three critical fields are queued, so an unbounded fan-out would show 3.
    expect(processor.peakParallelFieldCalls).toBe(
      MAX_PARALLEL_FIELD_REEXTRACTIONS,
    );
  });

  test("abandons the fields it runs out of time for", async () => {
    processor.passResponses = [
      emptyReceipt(),
      emptyReceipt({ store_name: "Coffee Bar" }),
    ];
    // A budget shorter than one call: the first two start before it expires,
    // and nothing after them does.
    processor.fieldCallDuration = 50;
    processor.limitPass3To(10);

    const result = await processor.extract("https://example.com/receipt.jpg");

    expect(processor.fieldCalls.length).toBe(MAX_PARALLEL_FIELD_REEXTRACTIONS);
    // The extraction still returns what the earlier passes did find.
    expect(result.data.store_name).toBe("Coffee Bar");
  });

  test("keeps each batch's own timeout and retry count", async () => {
    const recorder = new ProviderRecordingProcessor();
    recorder.passResponses = [
      emptyReceipt(),
      emptyReceipt({ store_name: "Coffee Bar" }),
    ];

    await recorder.extract("https://example.com/receipt.jpg");

    // Two whole-document passes, then total_amount, currency, date (critical)
    // and tax_amount (not).
    const fieldCalls = recorder.providerCalls.slice(2);
    expect(fieldCalls).toHaveLength(4);

    for (const call of fieldCalls.slice(0, 3)) {
      expect(call.options).toEqual({
        timeout: 90_000,
        retries: 1,
        retryDelay: 1000,
      });
    }

    expect(fieldCalls[3]?.options).toEqual({
      timeout: 30_000,
      retries: 1,
      retryDelay: 1000,
    });
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
