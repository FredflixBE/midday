/**
 * Which CSV column holds the date, the amount and the rest, as a model reads
 * the header and two sample rows. Server-side only: it calls a model, so it
 * is its own entry point rather than part of `@midday/import`, which the
 * dashboard bundles.
 */

import { languageModel } from "@midday/ai";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { buildCsvMappingPrompt } from "./csv-mapping-prompt";

export const csvMappingSchema = z.object({
  date: z.string().optional(),
  description: z.string().optional(),
  counterparty: z.string().optional(),
  amount: z.string().optional(),
  balance: z.string().optional(),
  currency: z.string().optional(),
});

export type CsvMapping = z.infer<typeof csvMappingSchema>;

/** A currency the model inferred because no column holds one (rule 4 of the prompt). */
const ISO_CURRENCY = /^[A-Z]{3}$/;

/**
 * The mapping with every answer the file cannot honour removed: a column it
 * does not have, and a counterparty that is the description's own column.
 * Each kept answer is the file's own column name, exactly as its header has it.
 * The prompt asks for both already; this is what holds when the model forgets.
 */
export function keepRealColumns(
  mapping: CsvMapping,
  fieldColumns: string[],
): CsvMapping {
  // The prompt shows trimmed names, and the dashboard looks the answer up in
  // the file's raw header, so a trimmed answer goes back to the raw name.
  const rawByName = new Map<string, string>();
  for (const column of fieldColumns) {
    const name = column.trim();
    if (name && !rawByName.has(name)) rawByName.set(name, column);
  }

  const kept: CsvMapping = {};

  for (const [field, value] of Object.entries(mapping) as Array<
    [keyof CsvMapping, string | undefined]
  >) {
    if (!value) continue;
    const column = rawByName.get(value.trim());
    if (column) {
      kept[field] = column;
    } else if (field === "currency" && ISO_CURRENCY.test(value)) {
      kept[field] = value;
    }
  }

  if (kept.counterparty && kept.counterparty === kept.description) {
    delete kept.counterparty;
  }

  return kept;
}

export async function suggestCsvMapping({
  fieldColumns,
  firstRows,
  model = languageModel("helper"),
}: {
  fieldColumns: string[];
  firstRows: Record<string, string>[];
  /** The helper model from `@midday/ai` unless a test passes its own. */
  model?: LanguageModel;
}): Promise<CsvMapping> {
  const { object } = await generateObject({
    model,
    schema: csvMappingSchema,
    prompt: buildCsvMappingPrompt(fieldColumns, firstRows),
  });

  return keepRealColumns(object, fieldColumns);
}
