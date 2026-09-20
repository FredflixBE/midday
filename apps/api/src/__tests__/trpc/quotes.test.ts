/**
 * The quotes router's own behaviour (FF-1609): every call is scoped to the
 * caller's team, content is checked for its shape before it reaches the
 * database, and a broken version rule comes back as a bad request. The rules
 * themselves are tested against a database in packages/db.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptQuoteVersion,
  addQuoteTerms,
  createQuote,
  deleteQuoteTerms,
  getQuote,
  listQuotes,
  markQuoteVersionSent,
  QuoteInputError,
  reviseQuote,
  setQuoteOutcome,
  updateQuoteDraft,
  updateQuoteSettings,
} from "@midday/db/queries";
import { createCallerFactory } from "../../trpc/init";
import { quotesRouter } from "../../trpc/routers/quotes";
import { createTestContext } from "../helpers/test-context";
import { asMock, mocks } from "../setup";

const createCaller = createCallerFactory(quotesRouter);

const A = "a1b2c3d4-0000-4000-8000-000000000001";

describe("tRPC: quotes", () => {
  beforeEach(() => {
    for (const fn of [
      createQuote,
      getQuote,
      updateQuoteDraft,
      reviseQuote,
      updateQuoteSettings,
      markQuoteVersionSent,
      acceptQuoteVersion,
      addQuoteTerms,
      deleteQuoteTerms,
      setQuoteOutcome,
    ]) {
      asMock(fn).mockReset();
      asMock(fn).mockImplementation(() => Promise.resolve({}));
    }
  });

  test("a quote is created on the caller's team, by the caller", async () => {
    const caller = createCaller(createTestContext());

    await caller.create({
      customerId: A,
      title: "Proposal",
      kind: "project",
      language: "nl",
    });

    expect(asMock(createQuote).mock.calls[0]?.[1]).toMatchObject({
      customerId: A,
      title: "Proposal",
      kind: "project",
      language: "nl",
      teamId: "test-team-id",
      userId: "test-user-id",
    });
  });

  test("another team's quote or customer is not found", async () => {
    asMock(getQuote).mockImplementation(() => Promise.resolve(null));
    asMock(createQuote).mockImplementation(() => Promise.resolve(null));
    const caller = createCaller(createTestContext());

    await expect(caller.get({ id: A })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller.create({
        customerId: A,
        title: "Proposal",
        kind: "project",
        language: "en",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("editing a sent version is a bad request", async () => {
    asMock(updateQuoteDraft).mockImplementation(() =>
      Promise.reject(new QuoteInputError("Only a draft can be edited")),
    );
    const caller = createCaller(createTestContext());

    await expect(
      caller.updateDraft({ versionId: A, title: "Changed" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("content of the wrong shape never reaches the database", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.updateDraft({
        versionId: A,
        content: { blocks: [], scenarios: "none" } as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(asMock(updateQuoteDraft).mock.calls).toHaveLength(0);
  });

  test("a second draft is a bad request", async () => {
    asMock(reviseQuote).mockImplementation(() =>
      Promise.reject(new QuoteInputError("This quote already has a draft")),
    );
    const caller = createCaller(createTestContext());

    await expect(caller.revise({ quoteId: A })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  test("the list leaves each version's content and pricing behind", async () => {
    asMock(listQuotes).mockImplementation(() =>
      Promise.resolve([
        {
          id: A,
          quoteNumber: "OFF-0001",
          headline: null,
          version: { id: A, status: "draft", content: {}, pricing: null },
        },
      ]),
    );
    const caller = createCaller(createTestContext());

    const rows = await caller.list({ status: "draft" });

    expect(asMock(listQuotes).mock.calls[0]?.[1]).toMatchObject({
      teamId: "test-team-id",
      status: "draft",
    });
    expect(rows[0]?.version).toEqual({ id: A, status: "draft" } as never);
  });

  test("marking sent leaves the pricing to be worked out at that moment", async () => {
    const caller = createCaller(createTestContext());

    await caller.markSent({ versionId: A, sentTo: "  " });

    const call = asMock(markQuoteVersionSent).mock.calls[0]?.[1];
    expect(call).toMatchObject({
      teamId: "test-team-id",
      versionId: A,
      sentTo: null,
    });
    expect(call).not.toHaveProperty("pricing");
  });

  test("marking sent hands in a way to keep the PDF (FF-1615)", async () => {
    const caller = createCaller(createTestContext());

    await caller.markSent({ versionId: A });

    const call = asMock(markQuoteVersionSent).mock.calls[0]?.[1] as {
      storePdf: unknown;
    };
    expect(typeof call.storePdf).toBe("function");
  });

  test("an answer is recorded on the caller's team", async () => {
    const caller = createCaller(createTestContext());

    await caller.accept({
      versionId: A,
      scenarioId: "s1",
      optionalLineIds: ["extra"],
      poNumber: " PO-1 ",
      acceptedByName: "A. Buyer",
    });

    expect(asMock(acceptQuoteVersion).mock.calls[0]?.[1]).toMatchObject({
      teamId: "test-team-id",
      versionId: A,
      scenarioId: "s1",
      optionalLineIds: ["extra"],
      poNumber: "PO-1",
      acceptedByName: "A. Buyer",
    });
  });

  test("an answer that does not fit the version is a bad request", async () => {
    asMock(acceptQuoteVersion).mockImplementation(() =>
      Promise.reject(
        new QuoteInputError("That scenario is not one this version offers"),
      ),
    );
    const caller = createCaller(createTestContext());

    await expect(
      caller.accept({ versionId: A, scenarioId: "s9" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("another team's version is not accepted", async () => {
    asMock(acceptQuoteVersion).mockImplementation(() => Promise.resolve(null));
    const caller = createCaller(createTestContext());

    await expect(
      caller.accept({ versionId: A, scenarioId: "s1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("sending a version that is not a draft is a bad request", async () => {
    asMock(markQuoteVersionSent).mockImplementation(() =>
      Promise.reject(new QuoteInputError("Only a draft can be sent")),
    );
    const caller = createCaller(createTestContext());

    await expect(caller.markSent({ versionId: A })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  test("won is not an outcome set by hand", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.setOutcome({ quoteId: A, outcome: "won" as never, reason: null }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(asMock(setQuoteOutcome).mock.calls).toHaveLength(0);
  });

  test("a version of the terms is added on the caller's team", async () => {
    const caller = createCaller(createTestContext());

    await caller.addTerms({
      label: " 2026-01 ",
      language: "nl",
      filePath: ["team", "quotes", "terms.pdf"],
      fileName: "terms.pdf",
    });

    expect(asMock(addQuoteTerms).mock.calls[0]?.[1]).toMatchObject({
      teamId: "test-team-id",
      label: "2026-01",
      language: "nl",
    });
  });

  test("terms a quote was sent with are not removed", async () => {
    asMock(deleteQuoteTerms).mockImplementation(() =>
      Promise.reject(new QuoteInputError("A quote was sent with these terms")),
    );
    const caller = createCaller(createTestContext());

    await expect(caller.deleteTerms({ id: A })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  test("settings are the caller's team's", async () => {
    const caller = createCaller(createTestContext());

    await caller.updateSettings({ defaultValidDays: 45 });

    expect(asMock(updateQuoteSettings).mock.calls[0]?.[1]).toEqual({
      defaultValidDays: 45,
      teamId: "test-team-id",
    });
  });

  /**
   * FF-1626. Which pictures may go is the queries' decision; what the router
   * hands over is the means of letting go of them, bound to the caller's
   * team.
   */
  describe("letting go of a picture the text no longer holds", () => {
    beforeEach(() => {
      asMock(mocks.supabaseStorageRemove).mockClear();
    });

    function capturedDropImages(): (paths: string[]) => Promise<void> {
      const call = asMock(updateQuoteDraft).mock.calls[0]?.[1] as {
        dropImages?: (paths: string[]) => Promise<void>;
      };
      if (!call?.dropImages) throw new Error("no dropImages was handed over");
      return call.dropImages;
    }

    test("removes a picture from the team's own folder", async () => {
      const caller = createCaller(createTestContext());
      await caller.updateDraft({ versionId: A, title: "Changed" });

      await capturedDropImages()(["test-team-id/quotes/a.png"]);

      expect(asMock(mocks.supabaseStorageRemove).mock.calls[0]?.[0]).toEqual([
        "test-team-id/quotes/a.png",
      ]);
    });

    test("passes over a path that leaves the team's folder", async () => {
      const caller = createCaller(createTestContext());
      await caller.updateDraft({ versionId: A, title: "Changed" });

      await capturedDropImages()([
        "other-team/quotes/a.png",
        "test-team-id/../other-team/quotes/b.png",
      ]);

      expect(asMock(mocks.supabaseStorageRemove).mock.calls).toHaveLength(0);
    });
  });
});
