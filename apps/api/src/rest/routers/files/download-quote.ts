import type { Context } from "@api/rest/types";
import { downloadQuoteSchema } from "@api/schemas/files";
import { quotePdf } from "@api/services/quote-pdf";
import { createAdminClient } from "@api/services/supabase";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Database } from "@midday/db/client";
import { getQuotePdfInput, getQuoteVersionFile } from "@midday/db/queries";
import { verifyFileKey } from "@midday/encryption";
import { quotePdfFilename } from "@midday/quote";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { withDatabase } from "../../middleware/db";
import { withClientIp } from "../../middleware/ip";

/**
 * A quote version as a PDF (FF-1613), served the way the invoice download
 * is: the team's file key in `fk` says whose it is.
 *
 * A version that was sent has its PDF kept (FF-1615), and that file is what
 * is served: the logo, the payment details, the labels and the pictures in
 * the text are all read live when a quote is drawn, so redrawing a sent
 * version would not reproduce what the client holds. A draft — and a version
 * sent before its PDF was kept — is drawn now, at today's rates.
 */
const app = new OpenAPIHono<Context>();

const errorResponseSchema = z.object({ error: z.string() });

const withTeamFileKey: MiddlewareHandler = async (c, next) => {
  const fk = c.req.query("fk");
  const teamId = fk ? await verifyFileKey(fk) : null;
  if (!teamId) {
    throw new HTTPException(401, { message: "Invalid file key." });
  }
  c.set("teamId", teamId);
  await next();
};

app.openapi(
  createRoute({
    method: "get",
    path: "/quote",
    summary: "Download quote PDF",
    operationId: "downloadQuote",
    "x-speakeasy-name-override": "downloadQuote",
    description:
      "Downloads a version of a quote as a PDF. Requires the team file key (fk).",
    tags: ["Files"],
    request: { query: downloadQuoteSchema },
    responses: {
      200: {
        description: "Quote PDF",
        content: {
          "application/pdf": { schema: { type: "string", format: "binary" } },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
    middleware: [withClientIp, withDatabase, withTeamFileKey],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const { id, preview } = c.req.valid("query");

    const kept = await getQuoteVersionFile(db, { teamId, versionId: id });
    if (!kept) {
      throw new HTTPException(404, { message: "Quote not found" });
    }

    const pdf =
      (kept.pdfPath && (await stored(kept.pdfPath))) ??
      (await drawn(db, teamId, id));

    const headers: Record<string, string> = {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store, max-age=0",
    };
    if (!preview) {
      headers["Content-Disposition"] =
        `attachment; filename="${quotePdfFilename(kept.quoteNumber, kept.version)}"`;
    }

    return new Response(new Uint8Array(pdf), { headers });
  },
);

/**
 * The file kept when the version was sent. A path that reads back nothing
 * falls through to drawing the quote again: a vault someone tidied should
 * cost the exact file, not the download.
 */
async function stored(path: string[]): Promise<Buffer | null> {
  const supabase = await createAdminClient();
  const { data } = await supabase.storage
    .from("vault")
    .download(path.join("/"));
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}

/** The quote drawn as it stands now. */
async function drawn(
  db: Database,
  teamId: string,
  versionId: string,
): Promise<Buffer> {
  const input = await getQuotePdfInput(db, { teamId, versionId });
  if (!input) {
    throw new HTTPException(404, { message: "Quote not found" });
  }

  try {
    return await quotePdf(teamId, input);
  } catch (error: unknown) {
    throw new HTTPException(500, {
      message: `Failed to generate quote PDF: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

export { app as downloadQuoteRouter };
