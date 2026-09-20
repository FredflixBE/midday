import { beforeEach, describe, expect, mock, test } from "bun:test";
import { generateFileKey } from "@midday/encryption";

const renderQuotePdf = mock(async () => Buffer.from("%PDF-quote"));
mock.module("@midday/quote/pdf", () => ({ renderQuotePdf }));

/** What the vault gives back for the stored file, per test. */
let storedFile: Blob | null = null;
const storageDownload = mock(async () => ({
  data: storedFile,
  error: storedFile ? null : { message: "Object not found" },
}));
mock.module("@api/services/supabase", () => ({
  createClient: mock(async () => ({})),
  createAdminClient: mock(async () => ({
    storage: { from: () => ({ download: storageDownload }) },
  })),
}));

const { downloadQuoteRouter } = await import(
  "../../rest/routers/files/download-quote"
);
const { mocks } = await import("../setup");
const { OpenAPIHono } = await import("@hono/zod-openapi");

const TEAM = "00000000-0000-0000-0000-000000000001";
const VERSION = "b3b7c1e2-4c2a-4e7a-9c1a-2b7c1e24c2a4";

/** Enough of a version to be drawn: the text is walked for its pictures. */
const PDF_INPUT = {
  quoteNumber: "OFF-0007",
  version: 2,
  content: { blocks: [] },
};

function app() {
  const a = new OpenAPIHono();
  a.route("/files/download", downloadQuoteRouter);
  return a;
}

const url = (query: Record<string, string>) =>
  `/files/download/quote?${new URLSearchParams(query)}`;

/** A version of the key's team, with or without a PDF kept for it. */
function version(pdfPath: string[] | null) {
  mocks.getQuoteVersionFile.mockImplementation(() => ({
    pdfPath,
    quoteNumber: "OFF-0007",
    version: 2,
  }));
}

describe("GET /files/download/quote", () => {
  beforeEach(() => {
    mocks.getQuotePdfInput.mockReset();
    mocks.getQuoteVersionFile.mockReset();
    mocks.getQuotePdfInput.mockImplementation(() => PDF_INPUT);
    renderQuotePdf.mockClear();
    storageDownload.mockClear();
    storedFile = null;
  });

  test("without a valid file key it is refused", async () => {
    expect((await app().request(url({ id: VERSION }))).status).toBe(401);
    expect(
      (await app().request(url({ id: VERSION, fk: "not-a-key" }))).status,
    ).toBe(401);
    expect(mocks.getQuoteVersionFile).not.toHaveBeenCalled();
  });

  test("a version that is not the key's team's is not found", async () => {
    mocks.getQuoteVersionFile.mockImplementation(() => null);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk }));

    expect(res.status).toBe(404);
    expect(mocks.getQuoteVersionFile).toHaveBeenCalledWith(expect.anything(), {
      teamId: TEAM,
      versionId: VERSION,
    });
    expect(renderQuotePdf).not.toHaveBeenCalled();
  });

  test("a version without a kept PDF is drawn, named for its number", async () => {
    version(null);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="OFF-0007-v2.pdf"',
    );
    expect(await res.text()).toBe("%PDF-quote");
    expect(renderQuotePdf).toHaveBeenCalledWith({ ...PDF_INPUT, images: {} });
  });

  test("the file kept when it was sent is served, not drawn again", async () => {
    version([TEAM, "quotes", `${VERSION}.pdf`]);
    storedFile = new Blob(["%PDF-as-sent"]);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-as-sent");
    expect(storageDownload).toHaveBeenCalledWith(
      `${TEAM}/quotes/${VERSION}.pdf`,
    );
    expect(renderQuotePdf).not.toHaveBeenCalled();
    expect(mocks.getQuotePdfInput).not.toHaveBeenCalled();
  });

  test("a kept file that is gone falls back to drawing the quote", async () => {
    version([TEAM, "quotes", `${VERSION}.pdf`]);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-quote");
    expect(renderQuotePdf).toHaveBeenCalled();
  });

  test("a preview is shown inline", async () => {
    version(null);
    const fk = await generateFileKey(TEAM);

    const res = await app().request(url({ id: VERSION, fk, preview: "true" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBeNull();
  });
});
