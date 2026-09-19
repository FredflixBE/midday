import { renderToBuffer } from "@react-pdf/renderer";
import { type QuotePdfInput, quoteDocument } from "./document";
import { QuotePdf } from "./template";

export * from "./document";
export * from "./labels";
export { QuotePdf } from "./template";

/** A quote version as a PDF file. */
export function renderQuotePdf(input: QuotePdfInput) {
  return renderToBuffer(QuotePdf({ doc: quoteDocument(input) }));
}
