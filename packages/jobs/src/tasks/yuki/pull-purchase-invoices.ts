import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type YukiPullPurchaseInvoicesPayload,
  yukiPullPurchaseInvoicesSchema,
} from "@jobs/schemas/yuki";
import { inboxFileName } from "@jobs/utils/inbox-sync";
import {
  DEFAULT_YUKI_PULL_CUTOFF,
  DEFAULT_YUKI_PULL_LIMIT,
  planYukiPull,
  type YukiPullCandidate,
} from "@jobs/utils/yuki-pull";
import {
  calculateInboxSuggestions,
  createYukiInboxDocument,
  getInboxRowsForYukiPull,
  updateInbox,
  yukiInboxReference,
} from "@midday/db/queries";
import { createClient } from "@midday/supabase/job";
import { readYukiArchive } from "@midday/yuki/archive";
import type { YukiDocumentReader } from "@midday/yuki/documents";
import { fetchDocumentBinary } from "@midday/yuki/documents";
import { YukiNotConnectedError, yukiClientForTeam } from "@midday/yuki/team";
import { schemaTask } from "@trigger.dev/sdk";

/**
 * Pulls the purchase invoices Yuki holds and Midday does not (FF-1450).
 *
 * Yuki is the Peppol access point, so Belgian B2B supplier invoices land there
 * and never reach Gmail; the accountant also keys in and uploads invoices
 * directly. Midday's inbox — the best thing it does — is blind to exactly the
 * documents that matter most, which is why 284 of its transactions read
 * "invoice missing" while Yuki is waiting on 81 payments.
 *
 * What the run does to each document: fetch the PDF, store it in the team's
 * vault, insert an inbox row keyed on the Yuki document id, run Midday's own
 * matcher over it, and mark it done. Done whatever the matcher found, because
 * the accountant has already booked these — they must not sit in the inbox
 * looking like work.
 *
 * **It writes nothing to Yuki.** Every operation it issues is on the read
 * allowlist; the only writes are Midday's own rows and files, which Midday can
 * undo.
 */

/** How many rows the matcher is run over at once. */
const MATCHING_CONCURRENCY = 3;

type PulledDocument = { inboxId: string; documentId: string };

export class YukiPullPurchaseInvoicesProcessor extends BaseProcessor<YukiPullPurchaseInvoicesPayload> {
  async process(job: JobContext<YukiPullPurchaseInvoicesPayload>) {
    const {
      teamId,
      cutoff = DEFAULT_YUKI_PULL_CUTOFF,
      limit = DEFAULT_YUKI_PULL_LIMIT,
    } = job.data;
    const db = getDb();

    let client: Awaited<ReturnType<typeof yukiClientForTeam>>;
    try {
      client = await yukiClientForTeam(db, teamId);
    } catch (error) {
      // A team that has not connected Yuki is not a failure, it is most teams.
      if (error instanceof YukiNotConnectedError) {
        this.logger.info("Team has not connected Yuki, nothing to pull", {
          teamId,
        });
        return { teamId, skipped: true as const };
      }
      throw error;
    }

    // The archive is read fresh, at the top, and answers every question below.
    // `readYukiArchive` holds the read against the client, so a future run that
    // does the pull and FF-1493's decision in one process reads it once for
    // both — which is what keeps two steps of a run from seeing two different
    // archives. Across separate task runs it is 15 calls each, of 1,000 a day.
    const [archive, inboxRows] = await Promise.all([
      readYukiArchive(client),
      getInboxRowsForYukiPull(db, { teamId }),
    ]);

    const plan = planYukiPull({ archive, inboxRows, cutoff, limit });

    this.logger.info("Planned the pull", {
      teamId,
      cutoff,
      limit,
      ...plan.counts,
      unfinished: plan.finish.length,
      archiveDocuments: archive.documents.length,
      archiveCalls: archive.calls,
    });

    const supabase = createClient();
    const pulled: PulledDocument[] = [];
    const failed: string[] = [];

    // One document at a time. Yuki's allowance is generous but its patience is
    // not, and a run that is slower than it could be still finishes the backlog
    // in a few days — where a run that upsets the domain finishes none of it.
    for (const candidate of plan.pull) {
      try {
        pulled.push(
          await this.pullOne({ teamId, client, supabase, candidate }),
        );
      } catch (error) {
        // One document that cannot be fetched or stored must not abandon the
        // other forty-nine. It has no inbox row, so the next run tries again.
        failed.push(candidate.document.documentId);
        this.logger.error("Could not pull a Yuki document", {
          teamId,
          documentId: candidate.document.documentId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Rows an earlier run inserted but never finished are matched and closed
    // here too: their document id is taken, so nothing else would look at them.
    const toFinish = [...pulled.map((p) => p.inboxId), ...plan.finish];
    const matched = await this.matchAndClose({ teamId, inboxIds: toFinish });

    this.logger.info("Pulled Yuki purchase invoices", {
      teamId,
      pulled: pulled.length,
      failed: failed.length,
      finished: toFinish.length,
      ...matched,
      remaining: plan.counts.remaining,
    });

    return {
      teamId,
      skipped: false as const,
      cutoff,
      counts: plan.counts,
      pulled: pulled.length,
      failed: failed.length,
      finished: toFinish.length,
      ...matched,
    };
  }

  /** Fetch one document, store it, and insert its inbox row. */
  private async pullOne(params: {
    teamId: string;
    client: YukiDocumentReader;
    supabase: ReturnType<typeof createClient>;
    candidate: YukiPullCandidate;
  }): Promise<PulledDocument> {
    const { teamId, client, supabase, candidate } = params;
    const { document } = candidate;

    const bytes = await fetchDocumentBinary(client, {
      documentId: document.documentId,
    });

    const contentType = document.contentType ?? "application/pdf";
    // The same naming the mailbox sync uses, so two invoices that are both
    // called `invoice.pdf` do not overwrite each other in a flat bucket. The
    // suffix is the Yuki document id, which makes storing the same document
    // twice write the same file rather than a second one.
    const fileName = inboxFileName({
      filename: document.fileName ?? `${document.documentId}.pdf`,
      mimeType: contentType,
      referenceId: document.documentId,
    });

    const { data, error } = await supabase.storage
      .from("vault")
      .upload(`${teamId}/inbox/${fileName}`, bytes, {
        contentType,
        upsert: true,
      });

    // A document that never reached storage must not get an inbox row: the row
    // would render as a file that cannot be opened, and its reference id would
    // stop any later run from pulling the document again.
    if (error || !data) throw error ?? new Error("Upload returned no path");

    const row = await createYukiInboxDocument(getDb(), {
      teamId,
      referenceId: yukiInboxReference(document.documentId),
      filePath: data.path.split("/"),
      fileName,
      contentType,
      size: bytes.byteLength,
      // Yuki's own record of who billed and what for, which is a better source
      // than reading it back off the PDF — and 690 documents' worth cheaper
      // than asking a model to.
      displayName:
        document.contactName ??
        document.subject ??
        document.fileName ??
        fileName,
      amount: decimal(document.amount),
      // Yuki books a Belgian or Dutch administration in euro, and the archive
      // record carries no currency of its own. A foreign-currency invoice is
      // stored here as the euro amount Yuki booked, which is the amount the
      // bank charged — and the only one Midday's matcher can use.
      currency: "EUR",
      date: document.documentDate,
      taxAmount: decimal(document.vatAmount),
      invoiceNumber: document.reference,
      groupedInboxId: candidate.groupWith,
    });

    if (!row) {
      throw new Error(
        `Inserted no inbox row for Yuki document ${document.documentId}, and found none to use.`,
      );
    }

    return { inboxId: row.id, documentId: document.documentId };
  }

  /**
   * Runs Midday's matcher over the pulled rows and marks every one of them
   * done.
   *
   * Matching is worth doing even though nothing is waiting on it: it is what
   * fills `transaction_attachments`, so the transaction shows its invoice and
   * Midday's own reporting stops calling a booked purchase undocumented.
   *
   * Done whatever it found, because these are already in the accountant's
   * books. A suggestion the matcher raised stays raised — confirming it is
   * still one click on the transaction — but the document itself is not work.
   *
   * `calculateInboxSuggestions` is called here rather than through
   * `batch-process-matching` for two reasons: the ordering is ours (marking
   * done has to happen after matching, not racing it), and that task sends a
   * notification per match, which for a backlog of several hundred imported
   * documents is a mailbox full of nothing.
   */
  private async matchAndClose(params: {
    teamId: string;
    inboxIds: readonly string[];
  }): Promise<{ autoMatched: number; suggested: number; unmatched: number }> {
    const { teamId, inboxIds } = params;
    const db = getDb();
    const counts = { autoMatched: 0, suggested: 0, unmatched: 0 };

    for (let i = 0; i < inboxIds.length; i += MATCHING_CONCURRENCY) {
      await Promise.all(
        inboxIds.slice(i, i + MATCHING_CONCURRENCY).map(async (inboxId) => {
          try {
            const result = await calculateInboxSuggestions(db, {
              teamId,
              inboxId,
            });

            if (result.action === "auto_matched") counts.autoMatched += 1;
            else if (result.action === "suggestion_created")
              counts.suggested += 1;
            else counts.unmatched += 1;
          } catch (error) {
            // The matcher failing is not a reason to leave the row in the
            // inbox: it is still a document the accountant has booked. It is
            // closed either way, and the run says how many times this happened.
            counts.unmatched += 1;
            this.logger.warn("Matching a pulled document failed", {
              teamId,
              inboxId,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }

          await updateInbox(db, { id: inboxId, teamId, status: "done" });
        }),
      );
    }

    return counts;
  }
}

/**
 * Yuki's decimal string as a number, or null.
 *
 * The archive keeps amounts as strings on purpose — nothing in this integration
 * may *decide* on an amount, and a string cannot be compared by accident. This
 * is the one place that converts, because Midday's own inbox row stores a
 * number and its own matcher compares it against its own transactions: one
 * system, one currency, no cross-system comparison.
 */
function decimal(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const processor = new YukiPullPurchaseInvoicesProcessor();

export const yukiPullPurchaseInvoices = schemaTask({
  id: "yuki-pull-purchase-invoices",
  schema: yukiPullPurchaseInvoicesSchema,
  maxDuration: 600,
  // One run per team at a time. Every run is safe to repeat — the reference id
  // is unique — but two at once would fetch the same documents twice.
  queue: { concurrencyLimit: 1 },
  // A failed run is a connection problem or a changed Yuki response, and
  // neither improves by asking again immediately. Nothing is lost by waiting
  // for the next one: anything half-done is finished by the run after it.
  retry: { maxAttempts: 1 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "yuki-pull-purchase-invoices", payload, ctx),
});
