import type { Context } from "@api/rest/types";
import { downloadQuoteSchema } from "@api/schemas/files";
import { createAdminClient } from "@api/services/supabase";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getQuotePdfInput } from "@midday/db/queries";
import { verifyFileKey } from "@midday/encryption";
import type { ImageSource } from "@midday/invoice/templates/pdf/format";
import { imagePathsIn, quotePdfFilename } from "@midday/quote";
import { renderQuotePdf } from "@midday/quote/pdf";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { withDatabase } from "../../middleware/db";
import { withClientIp } from "../../middleware/ip";

/**
 * A quote version as a PDF (FF-1613), served the way the invoice download
 * is: the team's file key in `fk` says whose it is. A sent version renders
 * from the pricing frozen when it was sent, a draft at today's rates.
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

    const input = await getQuotePdfInput(db, { teamId, versionId: id });
    if (!input) {
      throw new HTTPException(404, { message: "Quote not found" });
    }

    let pdf: Buffer;
    try {
      pdf = await renderQuotePdf({
        ...input,
        images: await readImages(teamId, imagePathsIn(input.content)),
      });
    } catch (error: unknown) {
      throw new HTTPException(500, {
        message: `Failed to generate quote PDF: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store, max-age=0",
    };
    if (!preview) {
      headers["Content-Disposition"] =
        `attachment; filename="${quotePdfFilename(input.quoteNumber, input.version)}"`;
    }

    return new Response(new Uint8Array(pdf), { headers });
  },
);

/**
 * The bytes behind each picture a quote's text holds (FF-1625). The text
 * keeps a path, not an address, so the PDF cannot be drawn until they are
 * read. A path that reads back nothing is simply left out: a missing picture
 * must not cost the whole quote its PDF.
 *
 * Every path is checked to live under this team, so a doctored one cannot
 * pull a file out of another team's vault.
 */
async function readImages(
  teamId: string,
  paths: string[],
): Promise<Record<string, ImageSource>> {
  if (paths.length === 0) return {};

  const supabase = await createAdminClient();
  const images: Record<string, ImageSource> = {};

  await Promise.all(
    paths.map(async (path) => {
      if (!path.startsWith(`${teamId}/`)) return;

      const { data } = await supabase.storage.from("vault").download(path);
      if (!data) return;

      images[path] = {
        data: Buffer.from(await data.arrayBuffer()),
        format: data.type === "image/png" ? "png" : "jpg",
      };
    }),
  );

  return images;
}

export { app as downloadQuoteRouter };
