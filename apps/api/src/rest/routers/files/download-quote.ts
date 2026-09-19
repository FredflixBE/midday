import type { Context } from "@api/rest/types";
import { downloadQuoteSchema } from "@api/schemas/files";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getQuotePdfInput } from "@midday/db/queries";
import { verifyFileKey } from "@midday/encryption";
import { formatQuoteVersion } from "@midday/quote";
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
      pdf = await renderQuotePdf(input);
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
      const name = formatQuoteVersion(input.quoteNumber, input.version);
      headers["Content-Disposition"] =
        `attachment; filename="${name.replace(/\s+/g, "-")}.pdf"`;
    }

    return new Response(new Uint8Array(pdf), { headers });
  },
);

export { app as downloadQuoteRouter };
