import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import {
  type YukiDecideDeliveryPayload,
  yukiDecideDeliverySchema,
} from "@jobs/schemas/yuki";
import { reportYukiDelivery } from "@jobs/utils/yuki-delivery";
import type { InboxDocumentForYukiDelivery } from "@midday/db/queries";
import { extractTextFromPdf } from "@midday/documents/pdf-text";
import { createClient } from "@midday/supabase/job";
import { YukiNotConnectedError, yukiClientForTeam } from "@midday/yuki/team";
import { schemaTask } from "@trigger.dev/sdk";

/** Long enough to read one document, short enough not to hold up the run. */
const SIGNED_URL_TTL_SECONDS = 600;

/**
 * Works out, for every document in a team's inbox, whether Yuki already has it
 * (FF-1493).
 *
 * **Report only.** It reads Yuki and reads the inbox, and writes to neither.
 * That is the whole point of shipping it before FF-1458: the decision can be
 * run against live books and read over, repeatedly, with no way for a mistake
 * in it to reach anybody's accounts.
 */
export class YukiDecideDeliveryProcessor extends BaseProcessor<YukiDecideDeliveryPayload> {
  async process(job: JobContext<YukiDecideDeliveryPayload>) {
    const { teamId } = job.data;
    const supabase = createClient();

    let client: Awaited<ReturnType<typeof yukiClientForTeam>>;
    try {
      client = await yukiClientForTeam(getDb(), teamId);
    } catch (error) {
      // A team that has not connected Yuki is not a failure, it is most teams.
      if (error instanceof YukiNotConnectedError) {
        this.logger.info("Team has not connected Yuki, nothing to decide", {
          teamId,
        });
        return { teamId, skipped: true as const };
      }
      throw error;
    }

    const readDocumentText = async (
      document: InboxDocumentForYukiDelivery,
    ): Promise<string | null> => {
      const path = document.filePath?.join("/");
      if (!path) return null;

      // Null is a real answer — it becomes "Needs attention: no text layer" —
      // so one unreadable document must not abandon the rest of the inbox.
      try {
        const { data } = await supabase.storage
          .from("vault")
          .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        if (!data?.signedUrl) return null;
        return await extractTextFromPdf(data.signedUrl);
      } catch (error) {
        this.logger.warn("Could not read a document's text layer", {
          teamId,
          inboxId: document.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return null;
      }
    };

    const report = await reportYukiDelivery({
      db: getDb(),
      teamId,
      client,
      readDocumentText,
    });

    this.logger.info("Decided what Yuki is missing", {
      teamId,
      ...report.counts,
      reasons: report.reasons,
      archiveDocuments: report.archive.documents,
      archiveCalls: report.archive.calls,
      textLayersRead: report.textLayersRead,
    });

    return report;
  }
}

const processor = new YukiDecideDeliveryProcessor();

export const yukiDecideDeliveryTask = schemaTask({
  id: "yuki-decide-delivery",
  schema: yukiDecideDeliverySchema,
  maxDuration: 600,
  // Nothing is written, so a retry cannot double anything up. It is still one
  // attempt: a failure here is a connection problem or a changed Yuki
  // response, and neither gets better by asking again immediately.
  retry: { maxAttempts: 1 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "yuki-decide-delivery", payload, ctx),
});
