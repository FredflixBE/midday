import { describe, expect, test } from "bun:test";
import { KBC_COLUMNS, KBC_ROWS } from "./kbc-fixture";
import { suggestCsvMapping } from "./suggest-mapping";

/**
 * The real question, asked of the real model: does a KBC export map the way a
 * person would map it? Needs ANTHROPIC_API_KEY, so CI skips it; run it with
 * the key after changing the model or the prompt.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "suggestCsvMapping, live",
  () => {
    test("maps a KBC export: Munt is the currency, Valuta is a date", async () => {
      const mapping = await suggestCsvMapping({
        fieldColumns: KBC_COLUMNS,
        firstRows: KBC_ROWS,
      });

      expect(mapping.date).toBe("Datum");
      expect(mapping.amount).toBe("Bedrag");
      expect(mapping.description).toBe("Omschrijving");
      expect(mapping.counterparty).toBe("Naam tegenpartij");
      expect(mapping.balance).toBe("Saldo");
      expect(mapping.currency).toBe("Munt");
    }, 60_000);
  },
);
