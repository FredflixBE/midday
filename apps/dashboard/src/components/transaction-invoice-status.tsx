import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";

export type InvoiceStatus =
  | "invoice_missing"
  | "invoice_pending"
  | "invoice_attached"
  | "no_invoice_needed";

export type BooksStatus = "invoice_missing" | "in_the_books" | "needs_attention";

/**
 * Midday's own answer about a transaction's invoice, with the accountant's
 * answer underneath it (FF-1499).
 *
 * Two lines rather than two columns. The table is already wide, and a second
 * column beside the existing "Exported" would read as an alternative to it
 * rather than an answer to a different question.
 *
 * Nothing here names the accounting package. The books are an integration that
 * feeds Midday's own metrics, and a user reading this screen should never have
 * to know which one.
 */

const INVOICE_LABELS: Record<InvoiceStatus, string> = {
  invoice_missing: "Invoice missing",
  invoice_pending: "Invoice found",
  invoice_attached: "Invoice attached",
  no_invoice_needed: "No invoice needed",
};

/**
 * Every status says what it means where it is shown. "Invoice found" and
 * "Invoice attached" are a word apart and mean opposite things about whether
 * you still have something to do.
 */
const INVOICE_EXPLANATIONS: Record<InvoiceStatus, string> = {
  invoice_missing: "No invoice for this payment yet.",
  invoice_pending: "We found a likely invoice. Confirm or dismiss it.",
  invoice_attached: "The invoice for this payment is filed against it.",
  no_invoice_needed: "Marked as needing no invoice — a fee, tax or charge.",
};

const INVOICE_COLOURS: Partial<Record<InvoiceStatus, string>> = {
  invoice_missing: "#878787",
  invoice_pending: "#ff9800",
};

const BOOKS_LABELS: Record<BooksStatus, string> = {
  invoice_missing: "not in the books",
  in_the_books: "in the books",
  needs_attention: "books disagree",
};

const BOOKS_EXPLANATIONS: Record<BooksStatus, string> = {
  invoice_missing: "Your accountant is still waiting for this invoice.",
  in_the_books: "Your accountant has it, and it is settled.",
  needs_attention:
    "The two halves of this booking did not agree, so nothing was decided.",
};

type Props = {
  invoiceStatus: InvoiceStatus;
  booksStatus?: BooksStatus | null;
};

export function TransactionInvoiceStatus({ invoiceStatus, booksStatus }: Props) {
  const label = INVOICE_LABELS[invoiceStatus];
  const colour = INVOICE_COLOURS[invoiceStatus];

  // Null is a real answer and a different one from "missing": the books have
  // nothing to say about this payment — today every bank transaction, because
  // nothing joins a bank line to a booking (FF-1537). Saying so is honest;
  // showing "not in the books" would not be.
  const books = booksStatus ? BOOKS_LABELS[booksStatus] : null;

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex flex-col cursor-default leading-tight">
            <span style={colour ? { color: colour } : undefined}>{label}</span>
            {books && (
              <span className="text-[11px] text-[#878787]">{books}</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent sideOffset={10} className="text-xs">
          <div className="flex flex-col gap-1">
            <p>{INVOICE_EXPLANATIONS[invoiceStatus]}</p>
            {booksStatus && (
              <p className="text-[#878787]">
                {BOOKS_EXPLANATIONS[booksStatus]}
              </p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
