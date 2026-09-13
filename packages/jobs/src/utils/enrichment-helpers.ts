import type { TransactionForEnrichment } from "@midday/db/queries";
import type {
  EnrichmentResult,
  TransactionData,
  UpdateData,
} from "./enrichment-schema";
import {
  shouldUseCategoryResult,
  shouldUseMerchantResult,
  transactionCategories,
} from "./enrichment-schema";

/**
 * Generates the enrichment prompt for the LLM
 */
export function generateEnrichmentPrompt(
  transactionData: TransactionData[],
  batch: TransactionForEnrichment[],
): string {
  const transactionList = transactionData
    .map((tx, index) => {
      const transaction = batch[index];
      const hasExistingMerchant = transaction?.merchantName;

      return `${index + 1}. Description: "${tx.description}", Amount: ${tx.amount}, Currency: ${tx.currency}${hasExistingMerchant ? ` (Current Merchant: ${transaction.merchantName})` : ""}`;
    })
    .join("\n");

  const needsCategories = batch.some((tx) => !tx.categorySlug);

  let returnInstructions = "Return:\n";

  if (needsCategories) {
    returnInstructions +=
      "1. Legal entity name: Apply the transformation rules above\n";
    returnInstructions +=
      "2. Category: Select the best-fit category from the allowed list\n";
  } else {
    returnInstructions +=
      "Legal entity name: Apply the transformation rules above\n";
  }

  return `You are a legal entity identification system for business expense transactions.

TASK: For EVERY transaction, identify the formal legal business entity name with proper entity suffixes (Inc, LLC, Corp, Ltd, Co, etc.).

INPUT HIERARCHY (use in this priority order):
1. "Current Merchant": Existing name from provider → enhance to legal entity
2. "Counterparty": Bank-parsed name → identify legal entity
3. "Raw": Transaction description → extract legal entity
4. "Description": Additional context → supplement identification

TRANSFORMATION EXAMPLES:
✓ "Anthropic" → "Anthropic Inc"
✓ "Google Pay" → "Google LLC" 
✓ "AMZN MKTP" → "Amazon.com Inc"
✓ "Starbucks #1234" → "Starbucks Corporation"
✓ "MSFT*Office365" → "Microsoft Corporation"
✓ "Apple Store" → "Apple Inc"

REQUIREMENTS:
- Use official legal entity suffixes: Inc, LLC, Corp, Corporation, Ltd, Co, etc.
- Prefer the parent company's legal entity (Google LLC, not Google Pay LLC)
- Ignore location codes, store numbers, and transaction details
- If genuinely unknown, provide best cleaned/capitalized version available

CONFIDENCE SCORING:
- categoryConfidence: Rate your confidence in the category assignment (0-1)
  • 1.0 = Very certain (e.g., "Slack" → software)
  • 0.8 = Quite confident (e.g., "Hotel booking" → travel)  
  • 0.5 = Unsure (e.g., ambiguous merchant)
  • 0.2 = Very uncertain
- merchantConfidence: Rate your confidence in the merchant name (0-1)
  • 1.0 = Official company name found
  • 0.8 = Strong match with known entity
  • 0.5 = Best guess from available info
  • 0.2 = Very uncertain
- Only return category if confidence >= 0.7, otherwise return null

${
  needsCategories
    ? `
CATEGORIZATION RULES:
Assign categories based on merchant name and business purpose. Only return category if confidence >= 0.7, otherwise return null.

CONFIDENCE EXAMPLES:
• "Slack Technologies" → software (0.95)
• "Delta Air Lines" → travel (0.95)
• "ConEd Electric" → utilities (0.90)
• "ABC Corp payment" → null (0.4) (too uncertain)

COMMON CATEGORIES (only use if confident):
• software: SaaS tools (Slack, Google Workspace, GitHub, AWS)
• travel: Business trips (airlines, hotels, Uber to meetings)
• meals: Business dining (restaurants, client meals, catering)
• office-supplies: Stationery, consumables (paper, pens, supplies)
• equipment: Computers, furniture, tools >$500
• utilities: Utility bills (electric, water, gas, internet)
• rent: Office space, co-working, storage facilities
• marketing: Marketing services, agencies, SEO
• advertising: Ad platforms (Google Ads, Facebook Ads)
• insurance: Business insurance premiums
• contractors: Freelancer payments, 1099 contractors
• fees: Bank charges, processing fees, service fees
• website: Domains, hosting, web development
• domain-hosting: Specific hosting services (GoDaddy, Cloudflare)
• cloud-storage: Cloud services (Dropbox, Google Drive, AWS S3)
• training: Courses, certifications, conferences
• maintenance-repairs: Equipment repairs, building maintenance
• cleaning-supplies: Cleaning services, janitorial supplies
• security: Security systems, monitoring services
• credit-card-payment: Credit card transactions
• interest-expense: Loan interest payments
• uncategorized: Use when uncertain

TAX AND GOVERNMENT (a tax authority is never a supplier — use these, not a supplier category):
• vat-gst-pst-qst-payments: VAT / BTW / TVA / GST returns and prepayments. Belgian VAT
  offices appear as "Btw Ontvangsten", "Dienst Btw Ontvangsten", "BTW-Ontvangsten"
• income-tax-payments: Corporate or personal income tax, including prepayments
  ("Voorafbetalingen", "Versements anticipés")
• payroll-tax-remittances: Withheld payroll tax paid over to the authority
• employer-taxes: Employer social contributions (Belgium: a social insurance fund such
  as Xerius, Acerta, Liantis, Securex)
• government-fees: Registration, filing and licence fees
• taxes: Only when it is clearly a tax and the kind is genuinely unclear

PAYROLL AND OWNER:
• salary: Wages paid to employees, including one batched order covering several
• owner-draws: Money taken out by the owner for personal use

RULES:
1. Only categorize if confidence >= 0.7
2. When uncertain, return null for category
3. Focus on merchant name for clues
4. Consider business context and amount
5. A payment to a tax authority or a social insurance fund is a tax payment, never
   contractors or professional services
`
    : ""
}

${returnInstructions}

Transactions to process:
${transactionList}

Return exactly ${batch.length} results in order. Apply the transformation rules consistently.
`;
}

/**
 * Prepares transaction data for LLM processing
 */
export function prepareTransactionData(
  batch: TransactionForEnrichment[],
): TransactionData[] {
  return batch.map((tx) => {
    // Build a comprehensive description with all available information
    const parts: string[] = [];

    if (tx.counterpartyName) {
      parts.push(`Counterparty: ${tx.counterpartyName}`);
    }

    if (tx.name && tx.name !== tx.counterpartyName) {
      parts.push(`Raw: ${tx.name}`);
    }

    if (
      tx.description &&
      tx.description !== tx.counterpartyName &&
      tx.description !== tx.name
    ) {
      parts.push(`Description: ${tx.description}`);
    }

    // Fallback to just name if no counterparty
    const description = parts.length > 0 ? parts.join(" | ") : tx.name;

    return {
      description,
      amount: tx.amount.toString(),
      currency: tx.currency,
    };
  });
}

/** The two states that mean "nobody has classified this yet". */
export function isUnanswered(categorySlug: string | null): boolean {
  return !categorySlug || categorySlug === UNCATEGORIZED;
}

export const UNCATEGORIZED = "uncategorized";

/**
 * What the bank itself said this payment is, where ISO 20022 says it outright.
 *
 * Two codes identify a category with no inference at all, and both were being
 * guessed at instead: `SALA` is a salary payment — which is what the twelve
 * combined transfer orders on the live books are — and the `FTDP` family is a
 * loan or lease repayment.
 *
 * Deliberately short. A payment to the tax office and a payment to a supplier
 * are both `ICDT/ESCT`, so most codes say nothing about the category and this
 * returns null for them rather than pretending. Null on every transaction
 * stored before FF-1557, and on anything that is not a bank payment.
 */
export function categoryFromBankTransactionCode(transaction: {
  bankTransactionCode: string | null;
  bankTransactionSubCode: string | null;
}): string | null {
  if (transaction.bankTransactionSubCode === "SALA") {
    return "salary";
  }

  if (transaction.bankTransactionCode === "FTDP") {
    return "leases";
  }

  return null;
}

/**
 * One question per counterparty, not one per payment.
 *
 * The categoriser was asked about every transaction separately and disagreed
 * with itself: Xerius social contributions reached `contractors` twice and
 * `employer-taxes` once, and SD Worx — one payroll agency — was split across
 * two categories over twelve payments. Asking once and applying the answer to
 * the whole group is what makes the same supplier get the same category.
 *
 * Matching is exact on the trimmed, lower-cased name, so it merges repeats and
 * not near-misses: `Xerius` and `Xerius Sociaal Verzekeringsfonds` stay apart.
 * Merging those needs a real supplier identity, which is FF-1555.
 *
 * A payment naming nobody is its own group. 26 of 125 rows on the live books
 * have no counterparty, and pooling them would apply one supplier's answer to
 * all of them.
 */
export type EnrichmentGroup = {
  /** The row the prompt describes — the first of the group. */
  asked: TransactionForEnrichment;
  /** Everything the answer applies to, `asked` included. */
  transactions: TransactionForEnrichment[];
};

export function groupForEnrichment(
  batch: TransactionForEnrichment[],
): EnrichmentGroup[] {
  const groups = new Map<string, EnrichmentGroup>();

  for (const transaction of batch) {
    const named = transaction.counterpartyName ?? transaction.merchantName;
    // Unnamed rows key on their id, which nothing else can collide with.
    const key = named?.trim()
      ? `named:${named.trim().toLowerCase()}`
      : `alone:${transaction.id}`;

    const existing = groups.get(key);

    if (existing) {
      existing.transactions.push(transaction);
    } else {
      groups.set(key, { asked: transaction, transactions: [transaction] });
    }
  }

  return [...groups.values()];
}

/**
 * The categories nothing needs to ask a model about.
 *
 * Two sources, in order. The bank's own ISO 20022 code, where it identifies a
 * category outright. Then what this team has already decided for that
 * counterparty, which is what keeps one supplier in one category and makes a
 * human's correction carry forward.
 *
 * Returns transaction id → category, and says nothing about the rows it cannot
 * answer for. Those are the model's to guess at.
 */
export function knownCategories(
  batch: TransactionForEnrichment[],
  fromCounterparty: Map<string, string>,
): Map<string, string> {
  const known = new Map<string, string>();

  for (const transaction of batch) {
    if (!isUnanswered(transaction.categorySlug)) {
      continue;
    }

    const fromBank = categoryFromBankTransactionCode(transaction);

    if (fromBank) {
      known.set(transaction.id, fromBank);
      continue;
    }

    const named = transaction.counterpartyName ?? transaction.merchantName;
    const remembered = named?.trim()
      ? fromCounterparty.get(named.trim().toLowerCase())
      : undefined;

    if (remembered) {
      known.set(transaction.id, remembered);
    }
  }

  return known;
}

/** The counterparty names a batch would want a remembered category for. */
export function counterpartyNames(batch: TransactionForEnrichment[]): string[] {
  return batch
    .map(
      (transaction) => transaction.counterpartyName ?? transaction.merchantName,
    )
    .filter((name): name is string => !!name?.trim());
}

/**
 * Validates if a category is in the allowed list
 */
function isValidCategory(category: string): boolean {
  return transactionCategories.includes(
    category as (typeof transactionCategories)[number],
  );
}

/**
 * Prepares update data, enhancing merchant names to legal entity names and category classifications
 */
export function prepareUpdateData(
  transaction: {
    categorySlug: string | null;
    merchantName: string | null;
    amount: number;
  },
  result: EnrichmentResult,
  /**
   * A category that did not come from the model — the bank said it, or this team
   * has already classified this counterparty. It wins: it is deterministic, and
   * the model's job here is the merchant name, which it is still asked for.
   */
  knownCategory?: string | null,
): UpdateData {
  const updateData: UpdateData = {};

  // Only update merchantName if confidence is high enough
  if (shouldUseMerchantResult(result)) {
    updateData.merchantName = result.merchant!;
  }

  // Category assignment logic. `uncategorized` counts as unanswered: it is where
  // a run parks a row it could not classify, and treating it as a decision is
  // what made EUR 52,288 permanently unclassifiable — the row kept a non-null
  // slug, so no later run would ever assign one (FF-1554).
  if (isUnanswered(transaction.categorySlug) && transaction.amount <= 0) {
    if (knownCategory && isValidCategory(knownCategory)) {
      updateData.categorySlug = knownCategory;
    } else if (
      shouldUseCategoryResult(result) &&
      result.category &&
      isValidCategory(result.category)
    ) {
      // High confidence: use the suggested category
      updateData.categorySlug = result.category;
    } else {
      // No answer. Parked in `uncategorized` rather than left blank, so the row
      // reads as "asked and nobody could say" — a later run will ask again.
      updateData.categorySlug = UNCATEGORIZED;
    }
  }

  return updateData;
}
