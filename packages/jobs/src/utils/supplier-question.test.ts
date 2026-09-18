import { describe, expect, test } from "bun:test";
import { generateSupplierPrompt } from "./supplier-question";

const question = {
  name: "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart",
  counterpartyName: null,
  merchantName: null,
  description: null,
};

describe("generateSupplierPrompt", () => {
  test("lists the suppliers that exist, with the names merged into them", () => {
    const prompt = generateSupplierPrompt(
      [question],
      [
        { name: "Telenet BV", aliases: [] },
        { name: "Xerius Sociaal Verzekeringsfonds VZW", aliases: ["Xerius"] },
      ],
    );

    expect(prompt).toContain('- "Telenet BV"\n');
    expect(prompt).toContain(
      '- "Xerius Sociaal Verzekeringsfonds VZW" (also written "Xerius")',
    );
  });

  test("says nothing about known suppliers when there are none", () => {
    const prompt = generateSupplierPrompt([question], []);

    expect(prompt).not.toContain("Suppliers already known");
  });
});
