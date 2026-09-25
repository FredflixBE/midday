import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The viewer's worker is the dashboard's own `pdfjs-dist`, bundled as an
 * asset, while the API that talks to it is the copy `react-pdf` imports.
 * pdf.js refuses a worker whose version differs from its API, so a PDF
 * would never open. Bumping either package alone must fail here instead.
 */
const versionOf = (packageJson: string) =>
  JSON.parse(readFileSync(packageJson, "utf8")).version as string;

describe("pdf.js worker", () => {
  test("is the same pdfjs-dist version react-pdf runs", () => {
    const dashboard = createRequire(import.meta.url);
    const reactPdf = createRequire(dashboard.resolve("react-pdf"));

    expect(versionOf(dashboard.resolve("pdfjs-dist/package.json"))).toBe(
      versionOf(reactPdf.resolve("pdfjs-dist/package.json")),
    );
  });
});
