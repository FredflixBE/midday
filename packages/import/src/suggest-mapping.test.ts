import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { KBC_COLUMNS, KBC_ROWS } from "./kbc-fixture";
import { keepRealColumns, suggestCsvMapping } from "./suggest-mapping";

/** A model that answers every call with `answer` and records the prompts. */
function answering(answer: object) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(answer) }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe("suggestCsvMapping", () => {
  test("asks about the file's own columns and sample rows", async () => {
    const model = answering({ date: "Datum", amount: "Bedrag" });

    await suggestCsvMapping({
      fieldColumns: KBC_COLUMNS,
      firstRows: KBC_ROWS,
      model,
    });

    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("<column>Naam tegenpartij</column>");
    expect(prompt).toContain("EUROPESE DOMICILIERING");
  });

  test("returns the mapping the model gave", async () => {
    const mapping = await suggestCsvMapping({
      fieldColumns: KBC_COLUMNS,
      firstRows: KBC_ROWS,
      model: answering({
        date: "Datum",
        description: "Omschrijving",
        counterparty: "Naam tegenpartij",
        amount: "Bedrag",
        balance: "Saldo",
        currency: "Munt",
      }),
    });

    expect(mapping).toEqual({
      date: "Datum",
      description: "Omschrijving",
      counterparty: "Naam tegenpartij",
      amount: "Bedrag",
      balance: "Saldo",
      currency: "Munt",
    });
  });
});

describe("keepRealColumns", () => {
  test("drops a column the file does not have", () => {
    expect(
      keepRealColumns({ date: "Booking Date", amount: "Bedrag" }, KBC_COLUMNS),
    ).toEqual({ amount: "Bedrag" });
  });

  test("keeps an inferred currency code when no column holds the currency", () => {
    expect(keepRealColumns({ currency: "EUR" }, ["Date", "Amount"])).toEqual({
      currency: "EUR",
    });
    expect(keepRealColumns({ currency: "euros" }, ["Date"])).toEqual({});
  });

  test("never maps description and counterparty to the same column", () => {
    expect(
      keepRealColumns(
        { description: "Omschrijving", counterparty: "Omschrijving" },
        KBC_COLUMNS,
      ),
    ).toEqual({ description: "Omschrijving" });
  });
});
