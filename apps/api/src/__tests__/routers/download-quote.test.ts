import { beforeEach, describe, expect, mock, test } from "bun:test";
import { generateFileKey } from "@midday/encryption";

const renderQuotePdf = mock(async () => Buffer.from("%PDF-quote"));
mock.module("@midday/quote/pdf", () => ({ renderQuotePdf }));

const { downloadQuoteRouter } = await import(
  "../../rest/routers/files/download-quote"
);
const { mocks } = await import("../setup");
const { OpenAPIHono } = await import("@hono/zod-openapi");

const TEAM = "00000000-0000-0000-0000-000000000001";
const VERSION = "b3b7c1e2-4c2a-4e7a-9c1a-2b7c1e24c2a4";

function app() {
  const a = new OpenAPIHono();
  a.route("/files/download", downloadQuoteRouter);
  return a;
}

const url = (query: Record<string, string>) =>
  `/files/download/quote?${new URLSearchParams(query)}`;

describe("GET /files/download/quote", () => {
  beforeEach(() => {
    mocks.getQuotePdfInput.mockReset();
    renderQuotePdf.mockClear();
  });

  test("without a valid file key it is refused", async () => {
    expect((await app().request(url({ id: VERSION }))).status).toBe(401);
    expect(
      (await app().request(url({ id: VERSION, fk: "not-a-key" }))).status,
    ).toBe(401);
    expect(mocks.getQuotePdfInput).not.toHaveBeenCalled();
  });

  test("a version that is not the key's team's is not found", async () => {
    mocks.getQuotePdfInput.mockImplementation(() => null);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk }));

    expect(res.status).toBe(404);
    expect(mocks.getQuotePdfInput).toHaveBeenCalledWith(expect.anything(), {
      teamId: TEAM,
      versionId: VERSION,
    });
  });

  test("a version is the PDF, named for its number and version", async () => {
    const input = { quoteNumber: "OFF-0007", version: 2 };
    mocks.getQuotePdfInput.mockImplementation(() => input);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="OFF-0007-v2.pdf"',
    );
    expect(await res.text()).toBe("%PDF-quote");
    expect(renderQuotePdf).toHaveBeenCalledWith(input);
  });

  test("a preview is shown inline", async () => {
    mocks.getQuotePdfInput.mockImplementation(() => ({
      quoteNumber: "OFF-0007",
      version: 1,
    }));
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk, preview: "true" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBeNull();
  });
});
