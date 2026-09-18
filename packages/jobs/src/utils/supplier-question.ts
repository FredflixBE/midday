import type {
  AskSuppliers,
  KnownSupplier,
  SupplierAnswer,
  SupplierQuestion,
} from "@midday/db/queries";
import type { LanguageModel } from "ai";
import { generateObject } from "ai";
import { z } from "zod";

/**
 * The model's half of supplier recognition (FF-1555): who was paid, and which
 * part of the transaction says so.
 *
 * Asked only about payments no stored rule recognises, once per counterparty.
 * Its answer is kept as a rule by `recogniseSuppliers`, so the same supplier is
 * never asked about twice.
 */

export const supplierAnswerSchema = z.object({
  supplier: z
    .string()
    .nullable()
    .describe(
      "The legal entity that was paid, with its legal suffix (BV, NV, VZW, Ltd, Inc). Null when it cannot be told.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How sure you are of the supplier, 0 to 1"),
  namedBy: z
    .enum(["counterparty", "text"])
    .nullable()
    .describe(
      "'counterparty' when the Counterparty field is the supplier itself; 'text' when the supplier is named at the start of the Raw text instead",
    ),
  span: z
    .string()
    .nullable()
    .describe(
      "When namedBy is 'text': the leading words of Raw, copied exactly, that name the supplier — nothing after them",
    ),
});

export function generateSupplierPrompt(
  questions: SupplierQuestion[],
  known: KnownSupplier[],
): string {
  const list = questions
    .map((question, index) => {
      const parts = [`Raw: "${question.name}"`];
      if (question.counterpartyName) {
        parts.push(`Counterparty: "${question.counterpartyName}"`);
      }
      if (question.merchantName) {
        parts.push(`Merchant hint: "${question.merchantName}"`);
      }
      if (question.description && question.description !== question.name) {
        parts.push(`Description: "${question.description}"`);
      }
      return `${index + 1}. ${parts.join(" | ")}`;
    })
    .join("\n");

  const knownList = known
    .map((supplier) => {
      const also = supplier.aliases.map((alias) => JSON.stringify(alias));
      return `- ${JSON.stringify(supplier.name)}${also.length > 0 ? ` (also written ${also.join(", ")})` : ""}`;
    })
    .join("\n");

  const knownSection =
    known.length > 0
      ? `
Suppliers already known to this business:
${knownList}

When a transaction was paid to one of these companies, answer supplier with
its name exactly as listed first, even when the transaction spells it
differently. Give a new name only when none of them is the company paid — and
do not stretch one to fit: "KBC Bank NV" is not "KBC Verzekeringen NV".
`
      : "";

  return `You identify who a business paid, from its bank and card transactions.

For EVERY transaction, answer:

1. supplier: the legal entity paid — the company that will send the invoice.
   - One legal counterparty, not a brand family: "KBC Verzekeringen NV" and
     "KBC Bank NV" are different suppliers.
   - A payment processor or card terminal is NOT the supplier. "SumUp KIMAKH
     WAHIB Paris" was paid to Kimakh Wahib, not to SumUp. The same goes for
     Stripe, Mollie and Adyen. Lemon Squeezy ("LEMSQZY") is different: it is
     the merchant of record and sends the invoice itself, so it IS the supplier.
   - The card issuer or bank in the boilerplate ("Betaling Met Kbc Debetkaart",
     "Via Bancontact") is NOT the supplier.

2. namedBy: which field names the supplier.
   - "counterparty" when the Counterparty field is that company itself.
   - "text" when it is not — including when the Counterparty field is a
     collective bucket such as "Diverse leveranciers Restaurant" or "Various
     suppliers", or a payment processor.

3. span: only when namedBy is "text" — the leading words of Raw that name the
   supplier, copied exactly as they appear, stopping before anything that
   changes from one payment to the next (dates, amounts, references) and before
   the boilerplate. "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart Via
   Bancontact 28 12 2025" → span "Xerius Be2000 Antwerpen". The span must be
   the START of Raw. If the supplier is not named at the start, return null.

4. confidence: 0 to 1. Below 0.6 means you are guessing; say so rather than
   inventing a company.
${knownSection}
Transactions:
${list}

Return exactly ${questions.length} results, in order.`;
}

/** An `AskSuppliers` backed by a model. */
export function askSuppliersWith(model: LanguageModel): AskSuppliers {
  return async (questions, known) => {
    if (questions.length === 0) return [];

    const { object } = await generateObject({
      model,
      prompt: generateSupplierPrompt(questions, known),
      output: "array",
      schema: supplierAnswerSchema,
      temperature: 0.1,
    });

    return object as SupplierAnswer[];
  };
}
