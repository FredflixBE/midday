import { pdfjs } from "react-pdf";

// The worker is bundled with the app instead of fetched from unpkg, so a PDF
// opens without a cold connection to a third-party origin. It must be the
// pdfjs-dist version react-pdf runs; pdf-worker.test.ts holds the two together.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export { pdfjs };
