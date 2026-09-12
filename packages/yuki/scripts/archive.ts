/**
 * FF-1498 — read the whole archive and report what is in it.
 *
 * The same reader the purchase side uses, run against a real domain. It is how
 * the protocol assumptions are checked against a live Yuki rather than against
 * a fixture, and how the call cost of a full read is measured — the number the
 * whole "read it fresh every time" design rests on.
 *
 *   bun run --cwd packages/yuki archive
 *
 * Reads only, and every operation is on the allowlist. It writes nothing — not
 * to Yuki, not to a database, not to a file. It prints counts, type codes and
 * folder ids; no supplier, amount or invoice number reaches stdout, because
 * this repository is public and someone will paste the output into it.
 */
import {
  buildYukiArchive,
  isInvoiceDocumentType,
  listArchiveFolders,
  readArchiveFolder,
  type YukiArchiveDocument,
} from "../src/archive";
import { YukiClient } from "../src/client";
import { configFromEnv } from "./env";

function tally<T>(items: readonly T[], key: (item: T) => string) {
  const counts = new Map<string, number>();

  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const client = new YukiClient(configFromEnv());

  const folders = await listArchiveFolders(client);
  let calls = 1;
  const documents: YukiArchiveDocument[] = [];

  console.log(`${folders.length} folders.\n`);

  for (const folder of folders) {
    const page = await readArchiveFolder(client, { folderId: folder.id });
    calls += page.calls;
    documents.push(...page.documents);

    console.log(
      `  ${String(folder.id).padStart(4)} ${folder.description.padEnd(20)} ${String(
        page.documents.length,
      ).padStart(5)} documents, ${page.calls} call(s)${
        folder.processedByYuki ? "" : "  (a folder the team made)"
      }`,
    );
  }

  const invoices = documents.filter((d) => isInvoiceDocumentType(d.type));
  const numbered = invoices.filter((d) => d.referenceNormalized);
  const distinct = new Set(numbered.map((d) => d.referenceNormalized));

  console.log(`\n${documents.length} documents in ${calls} calls.`);
  console.log("\nBy type:");
  for (const [type, count] of tally(
    documents,
    (d) => `${d.type} ${d.typeDescription ?? ""}`,
  )) {
    console.log(`  ${type.padEnd(30)} ${String(count).padStart(5)}`);
  }

  console.log(
    `\n${invoices.length} of them are invoices, ${numbered.length} carrying a number, ${distinct.size} distinct.`,
  );

  // A number held by two invoices is expected — a supplier does reuse one —
  // and is why the lookup answers with a list.
  const reused = [
    ...tally(numbered, (d) => d.referenceNormalized ?? ""),
  ].filter(([, count]) => count > 1);
  console.log(
    `${reused.length} of those numbers are on more than one invoice.`,
  );

  // The numbers that are *not* on an invoice: bank statements and journal
  // entries carry a reference too, which is why the lookup filters on type.
  const others = documents.filter(
    (d) => d.referenceNormalized && !isInvoiceDocumentType(d.type),
  );
  const collisions = others.filter((d) =>
    distinct.has(d.referenceNormalized as string),
  );
  console.log(
    `${others.length} references sit on documents that are not invoices; ${collisions.length} of those collide with an invoice number.`,
  );

  const shortest = Math.min(
    ...numbered.map((d) => (d.referenceNormalized as string).length),
  );
  console.log(
    `The shortest invoice number normalises to ${shortest} characters — a match that short is weak evidence.`,
  );

  // The lookup, end to end on real data: every invoice number in the archive,
  // asked for exactly as Yuki wrote it, must find the document it came from.
  // Anything else means the normalisation is losing documents, which is the
  // failure that ends in a duplicate upload. Nothing is printed but the count.
  const archive = buildYukiArchive({ folders, documents, calls });
  const notFound = numbered.filter(
    (invoice) =>
      !archive
        .findInvoices(invoice.reference as string)
        .some((found) => found.documentId === invoice.documentId),
  );

  console.log(
    notFound.length === 0
      ? `\nAll ${numbered.length} invoice numbers find their own document.`
      : `\n${notFound.length} invoice numbers DO NOT find their own document — the lookup is losing invoices.`,
  );

  // The gap between the two questions, on real data. A number that some
  // document carries but no *invoice* carries is one where "not in Yuki" would
  // be the wrong answer and a second delivery the result.
  const unclassified = documents.filter(
    (d) =>
      d.referenceNormalized &&
      !isInvoiceDocumentType(d.type) &&
      archive.findInvoices(d.reference as string).length === 0,
  );
  console.log(
    `${unclassified.length} documents carry a number that no invoice carries — findDocuments answers for these, findInvoices does not.`,
  );

  // And a number with nothing comparable in it must be refused outright, not
  // answered "no". "No" means deliver the invoice, and Yuki cannot delete the
  // duplicate that follows.
  const refused = ["", "   ", "###", "-"].every((asked) => {
    try {
      archive.findInvoices(asked);
      return false;
    } catch {
      return true;
    }
  });
  console.log(
    refused
      ? "An empty or punctuation-only number is refused rather than answered, as it must be."
      : "An empty or punctuation-only number was ANSWERED — a blank invoice number would be delivered as new.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
