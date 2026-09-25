// The invoice sheet's chunk. Global sheets load it when the sheet first opens;
// the "Create invoice" buttons call it on hover or focus so it is usually
// there by the click.
export const loadInvoiceSheet = () => import("./invoice-sheet");

/** For pointer-enter and focus. A failed fetch surfaces when the sheet opens. */
export function preloadInvoiceSheet() {
  loadInvoiceSheet().catch(() => {});
}
