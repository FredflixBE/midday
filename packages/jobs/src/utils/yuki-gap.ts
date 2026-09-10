import {
  calculateAmountScore,
  calculateCurrencyScore,
  calculateDateScore,
  calculateNameScore,
  scoreMatch,
} from "@midday/db/utils/transaction-matching";
import type { YukiOutstandingItem } from "@midday/yuki";

/**
 * An inbox document, as far as matching it to a Yuki payment needs. Only
 * documents whose extraction finished are candidates, so amount and date are
 * always present.
 */
export interface InboxDocument {
  id: string;
  displayName: string | null;
  amount: number;
  currency: string | null;
  baseAmount: number | null;
  baseCurrency: string | null;
  date: string;
  invoiceNumber: string | null;
  website: string | null;
  type: "invoice" | "expense" | "other" | null;
}

export interface ScoredDocument {
  document: InboxDocument;
  confidence: number;
}

export interface YukiGapReport {
  /** Exactly one document clearly belongs to the payment. FF-1458 uploads these. */
  push: Array<{ payment: YukiOutstandingItem } & ScoredDocument>;
  review: Array<{ payment: YukiOutstandingItem; candidates: ScoredDocument[] }>;
  /** Yuki is missing an invoice and Midday has nothing for it either. */
  missing: Array<{ payment: YukiOutstandingItem }>;
  /** Outstanding in Yuki but not a gap: the invoice is there, just unpaid. */
  unpaidInvoices: number;
}

/**
 * Pushing a document into Yuki cannot be undone — no Yuki service exposes a
 * delete — so the bar is Midday's own auto-match standard, the one it applies
 * when it attaches a receipt without asking: high overall confidence and a name
 * that actually agrees.
 */
const PUSH_CONFIDENCE = 0.9;
const PUSH_NAME_SCORE = 0.4;

/**
 * Anything at or above Midday's default suggestion threshold is a document a
 * person could reasonably think is the one. A payment only goes out when its
 * strong match has no such rival.
 */
const PLAUSIBLE_CONFIDENCE = 0.6;

function score(
  payment: YukiOutstandingItem,
  document: InboxDocument,
  bookCurrency: string,
): { confidence: number; nameScore: number } {
  // Yuki keeps its books in one currency, and the payment is what the bank
  // actually charged, so it is its own base amount.
  const paid = Math.abs(payment.openAmount);
  const charge = {
    amount: paid,
    currency: bookCurrency,
    baseAmount: paid,
    baseCurrency: bookCurrency,
  };

  const nameScore = calculateNameScore(
    document.displayName,
    payment.description,
    payment.contact,
  );
  const amountScore = calculateAmountScore(document, charge);
  const currencyScore = calculateCurrencyScore(
    document.currency ?? undefined,
    bookCurrency,
    document.baseCurrency,
    bookCurrency,
  );
  const dateScore = calculateDateScore(
    document.date,
    payment.date,
    document.type,
  );
  const isSameCurrency = document.currency === bookCurrency;
  const isExactAmount = Math.abs(Math.abs(document.amount) - paid) < 0.01;

  return {
    confidence: scoreMatch({
      nameScore,
      amountScore,
      dateScore,
      currencyScore,
      isSameCurrency,
      isExactAmount,
    }),
    nameScore,
  };
}

export function reconcileYukiGap(params: {
  items: YukiOutstandingItem[];
  documents: InboxDocument[];
  bookCurrency: string;
}): YukiGapReport {
  const { items, documents, bookCurrency } = params;
  const payments = items.filter((i) => i.kind === "payment_awaiting_invoice");
  const report: YukiGapReport = {
    push: [],
    review: [],
    missing: [],
    unpaidInvoices: items.length - payments.length,
  };

  for (const payment of payments) {
    const scored = documents
      .map((document) => ({
        document,
        ...score(payment, document, bookCurrency),
      }))
      .sort((a, b) => b.confidence - a.confidence);

    const plausible = scored.filter(
      (s) => s.confidence >= PLAUSIBLE_CONFIDENCE,
    );
    const [only] = plausible;

    if (plausible.length === 0) {
      report.missing.push({ payment });
    } else if (
      plausible.length === 1 &&
      only &&
      only.confidence >= PUSH_CONFIDENCE &&
      only.nameScore >= PUSH_NAME_SCORE
    ) {
      report.push.push({
        payment,
        document: only.document,
        confidence: only.confidence,
      });
    } else {
      report.review.push({
        payment,
        candidates: plausible.map(({ document, confidence }) => ({
          document,
          confidence,
        })),
      });
    }
  }

  // One invoice cannot settle two payments. When the same document is the
  // clear match for several, every one of them goes to a person instead.
  const claims = new Map<string, number>();
  for (const { document } of report.push) {
    claims.set(document.id, (claims.get(document.id) ?? 0) + 1);
  }
  const contested = report.push.filter(
    ({ document }) => (claims.get(document.id) ?? 0) > 1,
  );
  if (contested.length > 0) {
    report.push = report.push.filter((p) => !contested.includes(p));
    for (const { payment, document, confidence } of contested) {
      report.review.push({ payment, candidates: [{ document, confidence }] });
    }
  }

  return report;
}
