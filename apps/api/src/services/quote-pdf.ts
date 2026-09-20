import { isTeamPath } from "@api/rest/routers/files/utils";
import { createAdminClient } from "@api/services/supabase";
import type { StoreQuotePdf } from "@midday/db/queries";
import type { ImageSource } from "@midday/invoice/templates/pdf/format";
import { imagePathsIn } from "@midday/quote";
import { type QuotePdfInput, renderQuotePdf } from "@midday/quote/pdf";

/**
 * Drawing a quote's PDF, in the one place that both the download (FF-1613)
 * and keeping the sent file (FF-1615) go through.
 */

/** What react-pdf can draw, and so what a picture may be. */
const PDF_FORMATS: Record<string, ImageSource["format"] | undefined> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

/**
 * The bytes behind each picture a quote's text holds (FF-1625). The text
 * keeps a path, not an address, so the PDF cannot be drawn until they are
 * read. A path that reads back nothing is simply left out: a missing picture
 * must not cost the whole quote its PDF.
 *
 * Every path is checked to live under this team, so a doctored one cannot
 * pull a file out of another team's vault, and only what react-pdf can draw
 * is handed to it.
 */
export async function readQuoteImages(
  teamId: string,
  paths: string[],
): Promise<Record<string, ImageSource>> {
  if (paths.length === 0) return {};

  const supabase = await createAdminClient();
  const images: Record<string, ImageSource> = {};

  await Promise.all(
    paths.map(async (path) => {
      if (!isTeamPath(teamId, path)) return;

      const { data } = await supabase.storage.from("vault").download(path);
      const format = PDF_FORMATS[data?.type ?? ""];
      if (!data || !format) return;

      images[path] = { data: Buffer.from(await data.arrayBuffer()), format };
    }),
  );

  return images;
}

/** A version's PDF, with the pictures its text names drawn in. */
export async function quotePdf(
  teamId: string,
  input: QuotePdfInput,
): Promise<Buffer> {
  return renderQuotePdf({
    ...input,
    images: await readQuoteImages(teamId, imagePathsIn(input.content)),
  });
}

/** Where a version's own PDF lives in the `vault` bucket. */
export function quotePdfPath(teamId: string, versionId: string) {
  return [teamId, "quotes", `${versionId}.pdf`];
}

/**
 * Keeps the PDF of a version, for the queries to call while the version is
 * being frozen (FF-1615). It throws when the file cannot be stored, which is
 * what takes the send back: a version marked sent whose PDF nobody has is
 * worse than a send that refused.
 */
export function storeQuotePdf(
  teamId: string,
  versionId: string,
): StoreQuotePdf {
  return async (input: QuotePdfInput) => {
    const pdf = await quotePdf(teamId, input);
    const path = quotePdfPath(teamId, versionId);

    const supabase = await createAdminClient();
    const { error } = await supabase.storage
      .from("vault")
      .upload(path.join("/"), pdf, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (error) throw error;

    return path;
  };
}
