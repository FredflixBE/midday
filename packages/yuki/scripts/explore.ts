/**
 * FF-1448 — the read-only spike.
 *
 * Answers the five questions the Yuki design still guesses at. Every call here
 * is a read; the client is constructed with no write operations enabled, so a
 * write cannot be issued even by mistake.
 *
 *   bun run --cwd packages/yuki explore
 *
 * Raw responses land in packages/yuki/.explore-output/ for inspection.
 *
 * Several parameter names below are inferred from Yuki's support docs rather
 * than read off a published signature. A wrong name comes back as a SOAP fault
 * naming the parameter — that is expected on a first run, and each probe
 * reports and continues rather than aborting the rest.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { YukiClient } from "../src/client";
import { configFromEnv } from "../src/config";
import { YUKI_FOLDERS } from "../src/types";

// `bun run --cwd packages/yuki explore` puts cwd at the package root.
const OUT = join(process.cwd(), ".explore-output");

type Probe = {
  id: string;
  question: string;
  run: (client: YukiClient) => Promise<unknown>;
};

const PURCHASE_FOLDER_ID = YUKI_FOLDERS.purchase;

/**
 * The bank's GL account. Domain-specific, so overridable. On a single-bank
 * Belgian domain it is typically 550001 — the first sub-account under the
 * "Zichtrekening" parent 550000, which itself holds nothing. Find yours in the
 * 09-gl-scheme output: an enabled 55xxxx account whose description names the
 * bank account.
 */
const BANK_GL_ACCOUNT = process.env.YUKI_BANK_GL_ACCOUNT?.trim() || "550001";

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const probes: Probe[] = [
  {
    id: "01-administrations",
    question:
      "Does the access key work, and which administrations does it see?",
    run: (c) => c.call("Administrations"),
  },
  {
    id: "02-document-folders",
    question: "Which folder is which? (Aankoop = 1, Verkoop = 2, Bank = 3)",
    run: (c) => c.call("DocumentFolders"),
  },
  {
    id: "03-backoffice-workflow",
    question:
      "Q1 — is BackOffice.GetWorkflow reachable, and does it list bank transactions awaiting an invoice? FF-1493 depends on this.",
    run: (c) => c.call("GetWorkflow", { administrationID: c.administrationId }),
  },
  {
    id: "04-outstanding-creditor-items",
    question:
      "Q1 fallback — unpaid purchase invoices, including bank transactions recorded on creditors.",
    run: (c) =>
      c.call("OutstandingCreditorItems", {
        administrationID: c.administrationId,
        includeBankTransactions: true,
        sortOrder: "DateDesc",
      }),
  },
  {
    id: "05-purchase-documents",
    question:
      "Q2/Q3 — recent Aankoop documents. Look for the same invoice twice (dual-channel duplicates) and for what marks a Peppol document.",
    run: (c) =>
      c.call("DocumentsInFolder", {
        folderID: PURCHASE_FOLDER_ID,
        sortOrder: "DocumentDateDesc",
        startDate: `${isoDaysAgo(120)}T00:00:00`,
        endDate: `${isoDaysAgo(0)}T23:59:59`,
        numberOfRecords: 50,
        startRecord: 0,
      }),
  },
  {
    id: "06-purchase-documents-incremental",
    question: "The exact call FF-1450 will use for its incremental cursor.",
    run: (c) =>
      c.call("ModifiedDocumentsInFolder", {
        folderID: PURCHASE_FOLDER_ID,
        sortOrder: "ModifiedAsc",
        modifiedSince: `${isoDaysAgo(120)}T00:00:00`,
        numberOfRecords: 50,
        startRecord: 0,
      }),
  },
  {
    id: "07-gl-transactions",
    question:
      "Q4 — bank GL transactions on 550001. How fresh is the newest entry, and does a contact distinguish a documented payment?",
    run: (c) =>
      c.call("GLAccountTransactions", {
        administrationID: c.administrationId,
        GLAccountCode: BANK_GL_ACCOUNT,
        StartDate: isoDaysAgo(120),
        EndDate: isoDaysAgo(0),
      }),
  },
  {
    id: "08-period-table",
    question: "Which fiscal periods exist, and which are closed?",
    run: (c) =>
      c.call("GetPeriodDateTable", {
        administrationID: c.administrationId,
        year: new Date().getFullYear(),
      }),
  },
  {
    id: "09-gl-scheme",
    question:
      "The chart of accounts — FF-1457 needs the VAT accounts and the revenue account.",
    run: (c) =>
      c.call("GetGLAccountScheme", { administrationID: c.administrationId }),
  },
  {
    id: "10-cost-categories",
    question: "Cost categories, for the expense side of FF-1457.",
    run: (c) => c.call("CostCategories"),
  },
  {
    id: "11-outstanding-debtor-items",
    question: "FF-1451 — which of my sales invoices are unpaid?",
    run: (c) =>
      c.call("OutstandingDebtorItems", {
        administrationID: c.administrationId,
        includeBankTransactions: true,
        sortOrder: "DateDesc",
      }),
  },
  {
    id: "12-backoffice-questions",
    question: "Outstanding questions the accountant has raised.",
    run: (c) =>
      c.call("GetOutstandingQuestions", {
        administrationID: c.administrationId,
      }),
  },
];

async function main() {
  const client = new YukiClient(configFromEnv());
  await mkdir(OUT, { recursive: true });

  console.log("Yuki read-only spike — no write operation is enabled.\n");

  const summary: string[] = [];

  for (const probe of probes) {
    process.stdout.write(`  ${probe.id} … `);
    try {
      const result = await probe.run(client);
      const body =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      await writeFile(join(OUT, `${probe.id}.txt`), body ?? "");
      const size = (body ?? "").length;
      console.log(`ok (${size} bytes)`);
      summary.push(`ok    ${probe.id}  ${probe.question}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(join(OUT, `${probe.id}.error.txt`), message);
      console.log(`failed — ${message}`);
      summary.push(`FAIL  ${probe.id}  ${message}`);
    }
  }

  await writeFile(join(OUT, "summary.txt"), summary.join("\n"));
  console.log(`\nRaw responses in ${OUT}`);
  console.log("Record the answers as a comment on FF-1448.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
