/**
 * Seam under test: quotes, their versions and the rules between them
 * (FF-1609).
 *
 * The rules the ticket asks tests for: only a draft is edited; revising
 * copies the latest version into a new draft, at most one at a time; sending
 * a new version supersedes the previous sent one; expired is computed. Also
 * numbering (`OFF-0001`, own sequence per team) and what a new quote starts
 * from.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml; see
 * suppliers.test.ts for how to run it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { QuoteContent } from "@midday/quote";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  createQuote,
  getQuote,
  getQuoteSettings,
  markQuoteVersionSent,
  QuoteInputError,
  reviseQuote,
  updateQuoteDraft,
  updateQuoteSettings,
} from "../queries/quotes";
import { customers, invoiceTemplates, quotes, quoteVersions } from "../schema";
import {
  seedAll,
  TEAM_EUR_ID,
  TEAM_USD_ID,
  TEST_USER_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();
const TODAY = "2026-09-19";

describe.skipIf(SKIP)("quotes", () => {
  let db: Database;
  let customerId: string;

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    customerId = await customer();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function customer(teamId = TEAM_USD_ID) {
    const [row] = await db
      .insert(customers)
      .values({
        teamId,
        name: "Example Customer",
        email: "customer@example.com",
        addressLine1: "Main Street 1",
        city: "Ghent",
        zip: "9000",
      })
      .returning({ id: customers.id });
    return row!.id;
  }

  async function create(
    overrides: Partial<Parameters<typeof createQuote>[1]> = {},
  ) {
    const quote = await createQuote(db, {
      teamId: TEAM_USD_ID,
      userId: TEST_USER_ID,
      customerId,
      title: "Maintenance proposal",
      kind: "project",
      language: "en",
      today: TODAY,
      ...overrides,
    });
    return quote!;
  }

  function draftOf(quote: NonNullable<Awaited<ReturnType<typeof getQuote>>>) {
    const draft = quote.versions.find((v) => v.status === "draft");
    if (!draft) throw new Error("no draft");
    return draft;
  }

  describe("creating", () => {
    test("a new quote is version 1, a draft, numbered OFF-0001", async () => {
      const quote = await create();

      expect(quote).toMatchObject({
        quoteNumber: "OFF-0001",
        title: "Maintenance proposal",
        kind: "project",
        language: "en",
        currency: "USD",
        outcome: "open",
      });
      expect(quote.versions).toHaveLength(1);
      expect(quote.versions[0]).toMatchObject({
        version: 1,
        status: "draft",
        mode: "estimate",
        issueDate: TODAY,
        validUntil: "2026-10-19",
        expired: false,
      });
    });

    test("numbers follow each other per team, each team its own sequence", async () => {
      await create();
      const second = await create();
      const otherCustomer = await customer(TEAM_EUR_ID);
      const theirs = await create({
        teamId: TEAM_EUR_ID,
        customerId: otherCustomer,
      });

      expect(second.quoteNumber).toBe("OFF-0002");
      expect(theirs.quoteNumber).toBe("OFF-0001");
    });

    test("two quotes created at once get different numbers", async () => {
      const [a, b, c] = await Promise.all([create(), create(), create()]);
      expect(new Set([a.quoteNumber, b.quoteNumber, c.quoteNumber]).size).toBe(
        3,
      );
    });

    test("the team's prefix, validity and blocks are what a new quote starts from", async () => {
      await updateQuoteSettings(db, {
        teamId: TEAM_USD_ID,
        numberPrefix: "Q-",
        defaultValidDays: 14,
        hoursPerDay: 7.5,
        defaultBlocks: [
          {
            id: "licence",
            type: "text",
            heading: "Licences",
            body: { type: "doc", content: [] },
          },
        ],
      });

      const quote = await create();
      const draft = draftOf(quote);
      const content = draft.content as QuoteContent;

      expect(quote.quoteNumber).toBe("Q-0001");
      expect(draft.validUntil).toBe("2026-10-03");
      expect(content.hoursPerDay).toBe(7.5);
      expect(content.blocks.map((b) => b.type)).toEqual(["text", "pricing"]);
    });

    test("the customer and the sender are snapshotted", async () => {
      await db.insert(invoiceTemplates).values({
        teamId: TEAM_USD_ID,
        isDefault: true,
        fromDetails: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Us" }] },
          ],
        },
      });

      const quote = await create();
      const draft = draftOf(quote);

      expect(JSON.stringify(draft.customerDetails)).toContain(
        "Example Customer",
      );
      expect(JSON.stringify(draft.customerDetails)).toContain("9000 Ghent");
      expect(JSON.stringify(draft.fromDetails)).toContain("Us");
    });

    test("another team's customer is not found", async () => {
      const theirs = await customer(TEAM_EUR_ID);
      expect(
        await createQuote(db, {
          teamId: TEAM_USD_ID,
          userId: TEST_USER_ID,
          customerId: theirs,
          title: "x",
          kind: "project",
          language: "en",
        }),
      ).toBeNull();
    });
  });

  describe("editing", () => {
    test("a draft's content, mode and header can be changed", async () => {
      const quote = await create();
      const draft = draftOf(quote);
      const content = draft.content as QuoteContent;

      const updated = await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        title: "Maintenance and support",
        mode: "firm",
        content: { ...content, displayUnit: "days" },
      });

      expect(updated?.title).toBe("Maintenance and support");
      expect(draftOf(updated!)).toMatchObject({ mode: "firm" });
      expect((draftOf(updated!).content as QuoteContent).displayUnit).toBe(
        "days",
      );
    });

    test("content that is not a QuoteContent is refused", async () => {
      const draft = draftOf(await create());

      await expect(
        updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          content: { blocks: "nope" } as never,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("turning a project quote recurring needs every scenario to recur", async () => {
      const draft = draftOf(await create());
      const content = draft.content as QuoteContent;
      const scenario = {
        id: "s1",
        name: "Fixed",
        recommended: false,
        pricing: "fixed" as const,
        capped: false,
        recurrence: null,
        adjustmentOverride: null,
        paymentSchedule: [],
        lines: [],
      };
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        content: { ...content, scenarios: [scenario] },
      });

      await expect(
        updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          kind: "recurring",
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("a validity date before the issue date is refused", async () => {
      const draft = draftOf(await create());
      await expect(
        updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          validUntil: "2026-09-01",
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("changing the customer snapshots the new one", async () => {
      const draft = draftOf(await create());
      const [other] = await db
        .insert(customers)
        .values({
          teamId: TEAM_USD_ID,
          name: "Other Customer",
          email: "other@example.com",
        })
        .returning({ id: customers.id });

      const updated = await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        customerId: other!.id,
      });

      expect(updated?.customerId).toBe(other!.id);
      expect(JSON.stringify(draftOf(updated!).customerDetails)).toContain(
        "Other Customer",
      );
    });

    test("only a draft can be edited", async () => {
      const draft = draftOf(await create());
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        pricing: null,
      });

      await expect(
        updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          title: "Changed after sending",
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
      const quote = await getQuote(db, {
        id: draft.quoteId,
        teamId: TEAM_USD_ID,
      });
      expect(quote?.title).toBe("Maintenance proposal");
    });

    test("another team's version is not found", async () => {
      const draft = draftOf(await create());
      expect(
        await updateQuoteDraft(db, {
          teamId: TEAM_EUR_ID,
          versionId: draft.id,
          title: "x",
        }),
      ).toBeNull();
    });
  });

  describe("revising and sending", () => {
    async function sentQuote() {
      const quote = await create();
      const draft = draftOf(quote);
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        internalNote: "first round",
      });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        sentTo: "customer@example.com",
        pricing: { frozen: true },
      });
      return quote.id;
    }

    test("sending freezes the version with its pricing and recipient", async () => {
      const id = await sentQuote();
      const quote = await getQuote(db, { id, teamId: TEAM_USD_ID });

      expect(quote?.versions[0]).toMatchObject({
        status: "sent",
        sentTo: "customer@example.com",
        pricing: { frozen: true },
      });
      expect(quote?.versions[0]?.sentAt).not.toBeNull();
    });

    test("revising copies the latest version into a new draft, version + 1", async () => {
      const id = await sentQuote();

      const quote = await reviseQuote(db, {
        teamId: TEAM_USD_ID,
        quoteId: id,
        today: "2026-09-25",
      });

      expect(quote?.versions.map((v) => [v.version, v.status])).toEqual([
        [2, "draft"],
        [1, "sent"],
      ]);
      const [v2, v1] = quote!.versions;
      expect(v2).toMatchObject({
        content: v1!.content,
        mode: v1!.mode,
        internalNote: "first round",
        issueDate: "2026-09-25",
        validUntil: "2026-10-25",
        sentAt: null,
        sentTo: null,
        pricing: null,
      });
    });

    test("a quote has at most one draft", async () => {
      const quote = await create();
      await expect(
        reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: quote.id }),
      ).rejects.toBeInstanceOf(QuoteInputError);

      const id = await sentQuote();
      await reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: id });
      await expect(
        reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: id }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("two revisions at once make one draft", async () => {
      const id = await sentQuote();
      const results = await Promise.allSettled([
        reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: id }),
        reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: id }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const quote = await getQuote(db, { id, teamId: TEAM_USD_ID });
      expect(quote?.versions.filter((v) => v.status === "draft")).toHaveLength(
        1,
      );
    });

    test("sending the new version supersedes the previous sent one", async () => {
      const id = await sentQuote();
      const revised = await reviseQuote(db, {
        teamId: TEAM_USD_ID,
        quoteId: id,
      });

      const quote = await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(revised!).id,
        pricing: null,
      });

      expect(quote?.versions.map((v) => [v.version, v.status])).toEqual([
        [2, "sent"],
        [1, "superseded"],
      ]);
    });

    test("a version that is not a draft is not sent again", async () => {
      const id = await sentQuote();
      const quote = await getQuote(db, { id, teamId: TEAM_USD_ID });
      await expect(
        markQuoteVersionSent(db, {
          teamId: TEAM_USD_ID,
          versionId: quote!.versions[0]!.id,
          pricing: null,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("an accepted quote is not revised", async () => {
      const id = await sentQuote();
      const quote = await getQuote(db, { id, teamId: TEAM_USD_ID });
      await db
        .update(quoteVersions)
        .set({ status: "accepted" })
        .where(eq(quoteVersions.id, quote!.versions[0]!.id));

      await expect(
        reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: id }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("expired is read from the validity date, not stored", async () => {
      const id = await sentQuote();

      const before = await getQuote(db, {
        id,
        teamId: TEAM_USD_ID,
        today: "2026-10-19",
      });
      const after = await getQuote(db, {
        id,
        teamId: TEAM_USD_ID,
        today: "2026-10-20",
      });

      expect(before?.versions[0]).toMatchObject({
        status: "sent",
        expired: false,
      });
      expect(after?.versions[0]).toMatchObject({
        status: "sent",
        expired: true,
      });
    });

    test("another team's quote is not revised", async () => {
      const id = await sentQuote();
      expect(
        await reviseQuote(db, { teamId: TEAM_EUR_ID, quoteId: id }),
      ).toBeNull();
      const rows = await db.select().from(quotes);
      expect(rows).toHaveLength(1);
    });
  });

  describe("settings", () => {
    test("a team without settings gets the defaults", async () => {
      expect(await getQuoteSettings(db, TEAM_USD_ID)).toEqual({
        numberPrefix: "OFF-",
        defaultValidDays: 30,
        hoursPerDay: 8,
        defaultBlocks: [],
        labels: {},
      });
    });

    test("saving some settings keeps the rest", async () => {
      await updateQuoteSettings(db, {
        teamId: TEAM_USD_ID,
        defaultValidDays: 45,
      });
      await updateQuoteSettings(db, {
        teamId: TEAM_USD_ID,
        numberPrefix: "Q-",
      });

      expect(await getQuoteSettings(db, TEAM_USD_ID)).toMatchObject({
        numberPrefix: "Q-",
        defaultValidDays: 45,
      });
    });

    test("default blocks that are not blocks are refused", async () => {
      await expect(
        updateQuoteSettings(db, {
          teamId: TEAM_USD_ID,
          defaultBlocks: [{ id: "x", type: "video" }] as never,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });
  });
});
