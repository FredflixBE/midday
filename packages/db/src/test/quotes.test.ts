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
import { imagePathsIn, type QuoteContent } from "@midday/quote";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { createInvoiceProduct } from "../queries/invoice-products";
import { setCustomerProductRate } from "../queries/product-rates";
import {
  acceptQuoteVersion,
  addQuoteTerms,
  createQuote,
  deleteQuoteTerms,
  getPricedQuote,
  getQuote,
  getQuotePdfInput,
  getQuoteSettings,
  getQuoteVersionFile,
  listQuotes,
  listQuoteTerms,
  markQuoteVersionSent,
  QuoteInputError,
  reviseQuote,
  type StoreQuotePdf,
  setQuoteOutcome,
  undoQuoteAcceptance,
  updateQuoteDraft,
  updateQuoteSettings,
} from "../queries/quotes";
import {
  customers,
  invoiceProducts,
  invoiceTemplates,
  quotes,
  quoteVersions,
  teams,
  trackerProjects,
} from "../schema";
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
      // The team's own blocks, with the two a document cannot be written
      // without added around them: the contents at the top and the pricing
      // at the end (FF-1668).
      expect(content.blocks.map((b) => b.type)).toEqual([
        "contents",
        "text",
        "pricing",
      ]);
    });

    test("a prefix may end in digits, and a new prefix starts again at 0001", async () => {
      await updateQuoteSettings(db, {
        teamId: TEAM_USD_ID,
        numberPrefix: "Q2026",
      });
      const first = await create();
      const second = await create();
      await updateQuoteSettings(db, {
        teamId: TEAM_USD_ID,
        numberPrefix: "Q2027",
      });
      const next = await create();

      expect([first.quoteNumber, second.quoteNumber, next.quoteNumber]).toEqual(
        ["Q20260001", "Q20260002", "Q20270001"],
      );
    });

    test("the customer is snapshotted, and the sender is not yet", async () => {
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
      // FF-1641: the sender is frozen at sending, not here. Snapshotting it
      // at creation is what left a quote started before the details were
      // filled in with an empty From that revising could not put right.
      expect(draft.fromDetails).toBeNull();
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

    /**
     * FF-1626. A picture is stored the moment it is put in a quote's text and
     * nothing took it out again, so the vault only ever grew. The rule: a
     * picture is let go when a draft edit takes it out of the text and no
     * version of any quote still names it.
     */
    describe("a picture a draft no longer holds", () => {
      const picture = (path: string) => ({ type: "image", attrs: { path } });
      const textBlock = (id: string, nodes: unknown[]) => ({
        id,
        type: "text",
        heading: null,
        body: { type: "doc", content: nodes },
      });
      const withPictures = (
        content: QuoteContent,
        ...paths: string[]
      ): QuoteContent =>
        ({
          ...content,
          blocks: [textBlock("t1", paths.map(picture))],
        }) as unknown as QuoteContent;

      const A = `${TEAM_USD_ID}/quotes/a.png`;
      const B = `${TEAM_USD_ID}/quotes/b.png`;

      /** What the draft was asked to let go of. */
      async function editing(
        versionId: string,
        content: QuoteContent,
      ): Promise<string[]> {
        const dropped: string[] = [];
        await updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId,
          content,
          dropImages: async (paths) => {
            dropped.push(...paths);
          },
        });
        return dropped;
      }

      async function draftHolding(...paths: string[]) {
        const quote = await create();
        const draft = draftOf(quote);
        const content = draft.content as QuoteContent;
        await updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          content: withPictures(content, ...paths),
        });
        return { draft, content };
      }

      test("is let go of when nothing else names it", async () => {
        const { draft, content } = await draftHolding(A, B);

        expect(await editing(draft.id, withPictures(content, B))).toEqual([A]);
      });

      test("is kept while a version that was sent still shows it", async () => {
        const { draft, content } = await draftHolding(A);
        await markQuoteVersionSent(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          pricing: null,
        });
        const revised = await reviseQuote(db, {
          teamId: TEAM_USD_ID,
          quoteId: draft.quoteId,
          today: TODAY,
        });

        // The new draft drops it; the version the client was sent still
        // reads from it, and the editor draws that version from the path.
        expect(
          await editing(draftOf(revised!).id, withPictures(content)),
        ).toEqual([]);
      });

      test("is kept while another quote holds the same picture", async () => {
        const { draft, content } = await draftHolding(A);
        const other = await create({ title: "Second proposal" });
        await updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draftOf(other).id,
          content: withPictures(other.versions[0]!.content as QuoteContent, A),
        });

        expect(await editing(draft.id, withPictures(content))).toEqual([]);
      });

      test("is not looked for when the text did not change", async () => {
        const { draft } = await draftHolding(A);
        const dropped: string[] = [];

        await updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          internalNote: "Nothing to do with pictures",
          dropImages: async (paths) => {
            dropped.push(...paths);
          },
        });

        expect(dropped).toEqual([]);
      });

      test("stays in the vault when the edit is refused", async () => {
        const { draft, content } = await draftHolding(A);
        const dropped: string[] = [];

        await expect(
          updateQuoteDraft(db, {
            teamId: TEAM_USD_ID,
            versionId: draft.id,
            content: withPictures(content),
            validUntil: "2020-01-01",
            dropImages: async (paths) => {
              dropped.push(...paths);
            },
          }),
        ).rejects.toBeInstanceOf(QuoteInputError);

        expect(dropped).toEqual([]);
      });

      /**
       * A version's text is a Tiptap document nothing validates the inside of,
       * so a crafted save can put any path in a picture node. Dropping it
       * again must not reach the files the other quote tickets exist to keep.
       */
      test("never takes a file that is not a picture", async () => {
        const quote = await create();
        const first = draftOf(quote);
        await markQuoteVersionSent(db, {
          teamId: TEAM_USD_ID,
          versionId: first.id,
          pricing: null,
          storePdf: (async () => [
            TEAM_USD_ID,
            "quotes",
            `${first.id}.pdf`,
          ]) as StoreQuotePdf,
        });
        const terms = await addQuoteTerms(db, {
          teamId: TEAM_USD_ID,
          label: "2026-01",
          language: "en",
          filePath: [TEAM_USD_ID, "quotes", "terms.pdf"],
          fileName: "terms.pdf",
        });
        const revised = await reviseQuote(db, {
          teamId: TEAM_USD_ID,
          quoteId: first.quoteId,
          today: TODAY,
        });
        const draft = draftOf(revised!);
        const content = draft.content as QuoteContent;

        const storedPdf = `${TEAM_USD_ID}/quotes/${first.id}.pdf`;
        const termsFile = `${TEAM_USD_ID}/quotes/terms.pdf`;
        await updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          content: withPictures(content, storedPdf, termsFile, A),
        });

        expect(await editing(draft.id, withPictures(content))).toEqual([A]);
        expect(terms).not.toBeNull();
      });

      test("is let go of even when letting go fails", async () => {
        const { draft, content } = await draftHolding(A);

        const updated = await updateQuoteDraft(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          content: withPictures(content),
          dropImages: async () => {
            throw new Error("storage is down");
          },
        });

        // The edit stands: a file nobody can see is cheaper than an edit lost.
        expect(updated).not.toBeNull();
        expect(imagePathsIn(draftOf(updated!).content as QuoteContent)).toEqual(
          [],
        );
      });
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
        pricing: { scenarios: [] },
      });
      return quote.id;
    }

    test("sending freezes the version with its pricing and recipient", async () => {
      const id = await sentQuote();
      const quote = await getQuote(db, { id, teamId: TEAM_USD_ID });

      expect(quote?.versions[0]).toMatchObject({
        status: "sent",
        sentTo: "customer@example.com",
        pricing: { scenarios: [] },
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

    test("a revision keeps the header the client already has", async () => {
      const id = await sentQuote();
      const revised = await reviseQuote(db, {
        teamId: TEAM_USD_ID,
        quoteId: id,
      });
      const draft = draftOf(revised!);

      for (const change of [
        { title: "Renamed" },
        { language: "nl" as const },
        { kind: "recurring" as const },
        { customerId },
      ]) {
        await expect(
          updateQuoteDraft(db, {
            teamId: TEAM_USD_ID,
            versionId: draft.id,
            ...change,
          }),
        ).rejects.toBeInstanceOf(QuoteInputError);
      }

      // The rest of the draft is still editable.
      const updated = await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        mode: "firm",
      });
      expect(draftOf(updated!).mode).toBe("firm");
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

  describe("sending prices the version", () => {
    function oneScenario(productId: string, hours: number): QuoteContent {
      return {
        blocks: [{ id: "b1", type: "pricing" }],
        rates: { productRates: {}, volumeTiers: [], termTiers: [] },
        displayUnit: "hours",
        hoursPerDay: 8,
        scenarios: [
          {
            id: "s1",
            name: "Fixed price",
            recommended: true,
            pricing: "fixed",
            capped: false,
            recurrence: null,
            adjustmentOverride: null,
            paymentSchedule: [],
            lines: [
              {
                id: "l1",
                type: "item",
                title: "Workshop",
                description: null,
                productId,
                hours,
                hoursMax: null,
                optional: false,
                once: false,
              },
            ],
          },
        ],
      };
    }

    async function sendWith(productId: string) {
      const quote = await create();
      const draft = draftOf(quote);
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        content: oneScenario(productId, 10),
      });
      const sent = await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });
      const pricing = sent!.versions[0]!.pricing as {
        scenarios: { totals: { total: { amount: number } } }[];
      };
      return pricing.scenarios[0]!.totals.total.amount;
    }

    test("with the product's price when it is not given one", async () => {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });

      expect(await sendWith(product.id)).toBe(100000);
    });

    test("with the customer's own rate over the product's price", async () => {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });
      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId,
        productId: product.id,
        hourlyRate: 120,
      });

      expect(await sendWith(product.id)).toBe(120000);
    });

    test("an inactive product still prices the lines that use it", async () => {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });
      await db
        .update(invoiceProducts)
        .set({ isActive: false })
        .where(eq(invoiceProducts.id, product.id));

      expect(await sendWith(product.id)).toBe(100000);
    });
  });

  describe("what the PDF is made from", () => {
    async function productAt(price: number) {
      return createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price,
        currency: "USD",
        unit: "hour",
      });
    }

    function tenHoursOf(productId: string): QuoteContent {
      return {
        blocks: [{ id: "b1", type: "pricing" }],
        rates: { productRates: {}, volumeTiers: [], termTiers: [] },
        displayUnit: "days",
        hoursPerDay: 7.5,
        scenarios: [
          {
            id: "s1",
            name: "Fixed price",
            recommended: false,
            pricing: "fixed",
            capped: false,
            recurrence: null,
            adjustmentOverride: null,
            paymentSchedule: [],
            lines: [
              {
                id: "l1",
                type: "item",
                title: "Workshop",
                description: null,
                productId,
                hours: 10,
                hoursMax: null,
                optional: false,
                once: false,
              },
            ],
          },
        ],
      };
    }

    const total = (input: Awaited<ReturnType<typeof getQuotePdfInput>>) => {
      const totals = input!.pricing.scenarios[0]!.totals;
      return totals.kind === "project" ? totals.total.amount : null;
    };

    async function draftWith(productId: string) {
      const quote = await create();
      const draft = draftOf(quote);
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        content: tenHoursOf(productId),
      });
      return { quote, draft };
    }

    test("a draft, priced at today's rates, with everything around it", async () => {
      await db.insert(invoiceTemplates).values({
        teamId: TEAM_USD_ID,
        isDefault: true,
        logoUrl: "https://example.com/logo.png",
        fromDetails: { type: "doc", content: [] },
        paymentDetails: { type: "doc", content: [] },
      });
      await db
        .update(customers)
        .set({ countryCode: "NL" })
        .where(eq(customers.id, customerId));
      const product = await productAt(100);
      const { quote, draft } = await draftWith(product.id);
      await updateQuoteSettings(db, {
        teamId: TEAM_USD_ID,
        labels: { en: { estimate: "Our estimate." } },
      });

      const input = await getQuotePdfInput(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });

      expect(input).toMatchObject({
        quoteNumber: quote.quoteNumber,
        title: "Maintenance proposal",
        kind: "project",
        language: "en",
        currency: "USD",
        version: 1,
        mode: "estimate",
        issueDate: TODAY,
        validUntil: "2026-10-19",
        content: { displayUnit: "days", hoursPerDay: 7.5 },
        productNames: { [product.id]: "Development" },
        customerCountryCode: "NL",
        labels: { en: { estimate: "Our estimate." } },
        logoUrl: "https://example.com/logo.png",
        paymentDetails: { type: "doc", content: [] },
      });
      expect(input!.customerDetails).toEqual(draft.customerDetails);
      expect(total(input)).toBe(100000);
    });

    test("a sent version, from the pricing frozen when it was sent", async () => {
      const product = await productAt(100);
      const { draft } = await draftWith(product.id);
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });
      await db
        .update(invoiceProducts)
        .set({ price: 200 })
        .where(eq(invoiceProducts.id, product.id));

      const input = await getQuotePdfInput(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });
      expect(total(input)).toBe(100000);
    });

    test("a version sent before pricing was frozen is priced now", async () => {
      const product = await productAt(100);
      const { draft } = await draftWith(product.id);
      await db
        .update(quoteVersions)
        .set({ status: "sent", pricing: null })
        .where(eq(quoteVersions.id, draft.id));

      const input = await getQuotePdfInput(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });
      expect(total(input)).toBe(100000);
    });

    test("another team's version is not found", async () => {
      const { draft } = await draftWith((await productAt(100)).id);
      expect(
        await getQuotePdfInput(db, {
          teamId: TEAM_EUR_ID,
          versionId: draft.id,
        }),
      ).toBeNull();
    });

    // FF-1641. The From block used to be snapshotted when the quote was
    // created, so OFF-0004 read "Frederik Noels" and nothing else — no
    // address, no legal form, no enterprise number, no RPR, no bank account
    // — and filling any of it in afterwards changed neither that quote nor a
    // revision of it. A draft now reads it live; sending is what freezes it.
    describe("the sender on a quote", () => {
      const identity = {
        legalName: "Fredflix",
        legalForm: "BV",
        addressLine1: "Voorbeeldstraat 1",
        zip: "2000",
        city: "Antwerpen",
        enterpriseNumber: "0123.456.789",
        rprCourt: "Antwerpen, afdeling Antwerpen",
        bankIban: "BE68 5390 0754 7034",
      };

      const senderOf = async (versionId: string) =>
        JSON.stringify(
          (await getQuotePdfInput(db, { teamId: TEAM_USD_ID, versionId }))
            ?.fromDetails,
        );

      test("a draft started before the details were filled in still shows them", async () => {
        const { draft } = await draftWith((await productAt(100)).id);
        expect(await senderOf(draft.id)).toBe("null");

        await db.update(teams).set(identity).where(eq(teams.id, TEAM_USD_ID));

        const sender = await senderOf(draft.id);
        expect(sender).toContain("Fredflix BV");
        expect(sender).toContain("Ondernemingsnummer 0123.456.789");
        expect(sender).toContain("RPR Antwerpen, afdeling Antwerpen");
        expect(sender).toContain("IBAN BE68 5390 0754 7034");
      });

      // The case that actually bit: OFF-0004 was started before any of this
      // and carries the copy taken at creation. If that copy won, filling the
      // details in would still leave the quote reading "Frederik Noels".
      test("a draft carrying the old creation-time copy reads past it", async () => {
        const { draft } = await draftWith((await productAt(100)).id);
        await db
          .update(quoteVersions)
          .set({
            fromDetails: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Stale" }],
                },
              ],
            },
          })
          .where(eq(quoteVersions.id, draft.id));
        await db.update(teams).set(identity).where(eq(teams.id, TEAM_USD_ID));

        const sender = await senderOf(draft.id);
        expect(sender).toContain("Fredflix BV");
        expect(sender).not.toContain("Stale");
      });

      test("sending freezes it, and moving office afterwards does not reach it", async () => {
        const { draft } = await draftWith((await productAt(100)).id);
        await db.update(teams).set(identity).where(eq(teams.id, TEAM_USD_ID));

        await markQuoteVersionSent(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
        });
        expect(await senderOf(draft.id)).toContain("Voorbeeldstraat 1");

        await db
          .update(teams)
          .set({ addressLine1: "Nieuwe straat 9" })
          .where(eq(teams.id, TEAM_USD_ID));

        // What the client holds does not change under them.
        expect(await senderOf(draft.id)).toContain("Voorbeeldstraat 1");
      });

      test("falls back to the invoice template's From box when nothing is filled in", async () => {
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
        const { draft } = await draftWith((await productAt(100)).id);

        expect(await senderOf(draft.id)).toContain("Us");
      });

      test("the identity wins over the old From box once it is filled in", async () => {
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
        await db.update(teams).set(identity).where(eq(teams.id, TEAM_USD_ID));
        const { draft } = await draftWith((await productAt(100)).id);

        const sender = await senderOf(draft.id);
        expect(sender).toContain("Fredflix BV");
        expect(sender).not.toContain("Us");
      });
    });
  });

  describe("a quote with every version priced", () => {
    test("a draft at today's rates, a sent version as frozen, with names", async () => {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });
      const content: QuoteContent = {
        blocks: [{ id: "b1", type: "pricing" }],
        rates: { productRates: {}, volumeTiers: [], termTiers: [] },
        displayUnit: "hours",
        hoursPerDay: 8,
        scenarios: [
          {
            id: "s1",
            name: "Fixed price",
            recommended: false,
            pricing: "fixed",
            capped: false,
            recurrence: null,
            adjustmentOverride: null,
            paymentSchedule: [],
            lines: [
              {
                id: "l1",
                type: "item",
                title: "Workshop",
                description: null,
                productId: product.id,
                hours: 10,
                hoursMax: null,
                optional: false,
                once: false,
              },
            ],
          },
        ],
      };
      const quote = await create();
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
        content,
      });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
      });
      await reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: quote.id });
      await db
        .update(invoiceProducts)
        .set({ price: 200 })
        .where(eq(invoiceProducts.id, product.id));

      const priced = await getPricedQuote(db, {
        teamId: TEAM_USD_ID,
        id: quote.id,
      });

      expect(priced).toMatchObject({
        customerName: "Example Customer",
        productNames: { [product.id]: "Development" },
      });
      const totals = priced!.versions.map((v) => {
        const t = v.pricing.scenarios[0]!.totals;
        return [v.version, v.status, t.kind === "project" ? t.total.amount : 0];
      });
      expect(totals).toEqual([
        [2, "draft", 200000],
        [1, "sent", 100000],
      ]);
    });

    test("another team's quote is not found", async () => {
      const quote = await create();
      expect(
        await getPricedQuote(db, { teamId: TEAM_EUR_ID, id: quote.id }),
      ).toBeNull();
    });
  });

  describe("the list", () => {
    /** A quote sent with this validity, its outcome still open. */
    async function sent(issueDate: string, validUntil: string) {
      const quote = await create();
      const draft = draftOf(quote);
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        issueDate,
        validUntil,
      });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        pricing: null,
      });
      return quote.id;
    }

    async function numbers(
      status?: Parameters<typeof listQuotes>[1]["status"],
    ) {
      const rows = await listQuotes(db, {
        teamId: TEAM_USD_ID,
        status,
        today: TODAY,
      });
      return rows.map((row) => row.quoteNumber).sort();
    }

    test("each quote once, with its latest version", async () => {
      const id = await sent(TODAY, "2026-10-19");
      await reviseQuote(db, { teamId: TEAM_USD_ID, quoteId: id, today: TODAY });

      const rows = await listQuotes(db, { teamId: TEAM_USD_ID, today: TODAY });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        quoteNumber: "OFF-0001",
        customerName: "Example Customer",
        version: { version: 2, status: "draft", expired: false },
      });
    });

    test("the filters follow the latest version, its validity and the outcome", async () => {
      await create(); // OFF-0001, a draft
      await sent(TODAY, "2026-10-19"); // OFF-0002, awaiting an answer
      await sent(TODAY, "2026-09-24"); // OFF-0003, expiring within 7 days
      await sent("2026-09-01", "2026-09-18"); // OFF-0004, expired
      const lost = await sent(TODAY, "2026-10-19"); // OFF-0005
      await setQuoteOutcome(db, {
        teamId: TEAM_USD_ID,
        quoteId: lost,
        outcome: "lost",
        reason: "Went with another supplier",
      });
      const won = await sent(TODAY, "2026-10-19"); // OFF-0006
      await db.update(quotes).set({ outcome: "won" }).where(eq(quotes.id, won));

      expect(await numbers()).toHaveLength(6);
      expect(await numbers("draft")).toEqual(["OFF-0001"]);
      expect(await numbers("awaiting")).toEqual(["OFF-0002", "OFF-0003"]);
      expect(await numbers("expiring")).toEqual(["OFF-0003"]);
      expect(await numbers("expired")).toEqual(["OFF-0004"]);
      expect(await numbers("won")).toEqual(["OFF-0006"]);
      expect(await numbers("lost")).toEqual(["OFF-0005"]);
    });

    test("draft, sent, revised, sent again: the list follows each step", async () => {
      const quote = await create();
      const state = async (today = TODAY) => {
        const [row] = await listQuotes(db, { teamId: TEAM_USD_ID, today });
        const filters = [];
        for (const status of [
          "draft",
          "awaiting",
          "expiring",
          "expired",
        ] as const) {
          const rows = await listQuotes(db, {
            teamId: TEAM_USD_ID,
            status,
            today,
          });
          if (rows.length > 0) filters.push(status);
        }
        return {
          version: row!.version.version,
          status: row!.version.status,
          held: row!.held?.version ?? null,
          filters,
        };
      };

      expect(await state()).toEqual({
        version: 1,
        status: "draft",
        held: null,
        filters: ["draft"],
      });

      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
        pricing: null,
      });
      expect(await state()).toEqual({
        version: 1,
        status: "sent",
        held: 1,
        filters: ["awaiting"],
      });
      // Its validity (30 days) lapses.
      expect((await state("2026-10-20")).filters).toEqual(["expired"]);

      const revised = await reviseQuote(db, {
        teamId: TEAM_USD_ID,
        quoteId: quote.id,
        today: TODAY,
      });
      // The client still holds version 1, so it is still followed up.
      expect(await state()).toEqual({
        version: 2,
        status: "draft",
        held: 1,
        filters: ["draft", "awaiting"],
      });

      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(revised!).id,
        pricing: null,
      });
      expect(await state()).toEqual({
        version: 2,
        status: "sent",
        held: 2,
        filters: ["awaiting"],
      });
    });

    test("sending a new version of a lost quote opens it again", async () => {
      const id = await sent(TODAY, "2026-10-19");
      await setQuoteOutcome(db, {
        teamId: TEAM_USD_ID,
        quoteId: id,
        outcome: "lost",
        reason: "Too expensive",
      });
      const revised = await reviseQuote(db, {
        teamId: TEAM_USD_ID,
        quoteId: id,
        today: TODAY,
      });

      const resent = await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(revised!).id,
        pricing: null,
      });

      expect(resent).toMatchObject({
        outcome: "open",
        outcomeReason: null,
        outcomeAt: null,
      });
      expect(await numbers("awaiting")).toEqual(["OFF-0001"]);
    });

    test("a quote valid until today is still awaiting, not expired", async () => {
      await sent("2026-09-01", TODAY);

      expect(await numbers("awaiting")).toEqual(["OFF-0001"]);
      expect(await numbers("expiring")).toEqual(["OFF-0001"]);
      expect(await numbers("expired")).toEqual([]);
    });

    test("each row has its amount, a draft's at today's rates", async () => {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });
      const quote = await create();
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
        content: {
          blocks: [],
          rates: { productRates: {}, volumeTiers: [], termTiers: [] },
          displayUnit: "hours",
          hoursPerDay: 8,
          scenarios: [
            {
              id: "s1",
              name: "Fixed price",
              recommended: false,
              pricing: "fixed",
              capped: false,
              recurrence: null,
              adjustmentOverride: null,
              paymentSchedule: [],
              lines: [
                {
                  id: "l1",
                  type: "item",
                  title: "Workshop",
                  description: null,
                  productId: product.id,
                  hours: 10,
                  hoursMax: null,
                  optional: false,
                  once: false,
                },
              ],
            },
          ],
        },
      });
      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId,
        productId: product.id,
        hourlyRate: 90,
      });

      const [row] = await listQuotes(db, { teamId: TEAM_USD_ID, today: TODAY });

      expect(row?.headline).toEqual({
        amount: { amount: 90000, max: null },
        per: "total",
      });
    });

    test("another team's quotes are not listed", async () => {
      await create();

      expect(
        await listQuotes(db, { teamId: TEAM_EUR_ID, today: TODAY }),
      ).toEqual([]);
    });
  });

  describe("outcome", () => {
    test("lost, with a reason and when it was decided", async () => {
      const quote = await create();

      const result = await setQuoteOutcome(db, {
        teamId: TEAM_USD_ID,
        quoteId: quote.id,
        outcome: "lost",
        reason: "Too expensive",
      });

      expect(result).toMatchObject({
        outcome: "lost",
        outcomeReason: "Too expensive",
      });
      expect(result?.outcomeAt).not.toBeNull();
    });

    test("reopened, the reason and the date go", async () => {
      const quote = await create();
      await setQuoteOutcome(db, {
        teamId: TEAM_USD_ID,
        quoteId: quote.id,
        outcome: "no_decision",
        reason: "Project postponed",
      });

      const result = await setQuoteOutcome(db, {
        teamId: TEAM_USD_ID,
        quoteId: quote.id,
        outcome: "open",
        reason: null,
      });

      expect(result).toMatchObject({
        outcome: "open",
        outcomeReason: null,
        outcomeAt: null,
      });
    });

    test("a won quote is not changed by hand", async () => {
      const quote = await create();
      await db
        .update(quotes)
        .set({ outcome: "won" })
        .where(eq(quotes.id, quote.id));

      await expect(
        setQuoteOutcome(db, {
          teamId: TEAM_USD_ID,
          quoteId: quote.id,
          outcome: "lost",
          reason: null,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("another team's quote is not found", async () => {
      const quote = await create();

      expect(
        await setQuoteOutcome(db, {
          teamId: TEAM_EUR_ID,
          quoteId: quote.id,
          outcome: "lost",
          reason: null,
        }),
      ).toBeNull();
    });
  });

  /**
   * FF-1615. Acceptance arrives outside Midday, so it is recorded by hand on
   * the version the client holds — and the PDF that went out is kept, since
   * the logo, the payment details, the labels and the pictures in the text
   * are all read live when a quote is drawn.
   */
  describe("acceptance", () => {
    /** Two scenarios; the first offers an optional item. */
    function twoScenarios(productId: string): QuoteContent {
      const item = (id: string, optional: boolean) => ({
        id,
        type: "item" as const,
        title: `Work ${id}`,
        description: null,
        productId,
        hours: 10,
        hoursMax: null,
        optional,
        once: false,
      });
      const scenario = (id: string, lines: ReturnType<typeof item>[]) => ({
        id,
        name: `Scenario ${id}`,
        recommended: false,
        pricing: "fixed" as const,
        capped: false,
        recurrence: null,
        adjustmentOverride: null,
        paymentSchedule: [],
        lines,
      });
      return {
        blocks: [{ id: "b1", type: "pricing" }],
        rates: { productRates: {}, volumeTiers: [], termTiers: [] },
        displayUnit: "hours",
        hoursPerDay: 8,
        scenarios: [
          scenario("s1", [item("base", false), item("extra", true)]),
          scenario("s2", [item("other", false)]),
        ],
      };
    }

    /** A quote whose version 1 has been sent, with a PDF kept for it. */
    async function sent(store: StoreQuotePdf | null = keeper()) {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });
      const quote = await create();
      const draft = draftOf(quote);
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        content: twoScenarios(product.id),
      });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        storePdf: store ?? undefined,
      });
      return { quoteId: quote.id, versionId: draft.id };
    }

    /** Stands in for rendering and storing: remembers what it was handed. */
    function keeper() {
      const seen: unknown[] = [];
      const store: StoreQuotePdf & { seen: unknown[] } = Object.assign(
        async (input: unknown) => {
          seen.push(input);
          return [TEAM_USD_ID, "quotes", "kept.pdf"];
        },
        { seen },
      );
      return store;
    }

    async function versionRow(versionId: string) {
      const [row] = await db
        .select()
        .from(quoteVersions)
        .where(eq(quoteVersions.id, versionId));
      return row!;
    }

    test("sending keeps the PDF, drawn from the pricing just frozen", async () => {
      const store = keeper();
      const { versionId } = await sent(store);

      const row = await versionRow(versionId);
      expect(row.pdfPath).toEqual([TEAM_USD_ID, "quotes", "kept.pdf"]);
      expect(store.seen).toHaveLength(1);
      const input = store.seen[0] as {
        pricing: { scenarios: { totals: { total: { amount: number } } }[] };
      };
      expect(input.pricing.scenarios[0]!.totals.total.amount).toBe(100000);
    });

    test("a PDF that cannot be kept refuses the send", async () => {
      const quote = await create();
      const draft = draftOf(quote);

      await expect(
        markQuoteVersionSent(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
          storePdf: async () => {
            throw new Error("the vault said no");
          },
        }),
      ).rejects.toThrow("the vault said no");

      const row = await versionRow(draft.id);
      expect(row.status).toBe("draft");
      expect(row.sentAt).toBeNull();
      expect(row.pricing).toBeNull();
    });

    test("accepting records the answer and wins the quote", async () => {
      const { quoteId, versionId } = await sent();

      const quote = await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId,
        scenarioId: "s1",
        optionalLineIds: ["extra"],
        acceptedAt: "2026-09-18",
        acceptedByName: "  A. Buyer  ",
        poNumber: " PO-42 ",
        acceptanceFilePath: [TEAM_USD_ID, "quotes", "order-form.pdf"],
        today: TODAY,
      });

      expect(quote!.id).toBe(quoteId);
      expect(quote!.outcome).toBe("won");
      expect(quote!.outcomeAt).not.toBeNull();
      expect(quote!.versions[0]).toMatchObject({
        status: "accepted",
        acceptedScenarioId: "s1",
        acceptedOptionalLineIds: ["extra"],
        acceptedByName: "A. Buyer",
        poNumber: "PO-42",
        acceptanceFilePath: [TEAM_USD_ID, "quotes", "order-form.pdf"],
      });
      expect(quote!.versions[0]!.acceptedAt).toContain("2026-09-18");
    });

    test("the PDF kept when it was sent is not drawn again", async () => {
      const { versionId } = await sent();
      const store = keeper();

      await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId,
        scenarioId: "s1",
        storePdf: store,
        today: TODAY,
      });

      expect(store.seen).toHaveLength(0);
      expect((await versionRow(versionId)).pdfPath).toEqual([
        TEAM_USD_ID,
        "quotes",
        "kept.pdf",
      ]);
    });

    test("a version sent before its PDF was kept gets one now", async () => {
      const { versionId } = await sent(null);
      expect((await versionRow(versionId)).pdfPath).toBeNull();
      const store = keeper();

      await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId,
        scenarioId: "s1",
        storePdf: store,
        today: TODAY,
      });

      expect(store.seen).toHaveLength(1);
      expect((await versionRow(versionId)).pdfPath).toEqual([
        TEAM_USD_ID,
        "quotes",
        "kept.pdf",
      ]);
    });

    test("recording it again replaces what was recorded", async () => {
      const { versionId } = await sent();
      const accept = (scenarioId: string, poNumber: string) =>
        acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId,
          scenarioId,
          poNumber,
          today: TODAY,
        });

      await accept("s1", "PO-1");
      const quote = await accept("s2", "PO-2");

      expect(quote!.versions[0]).toMatchObject({
        status: "accepted",
        acceptedScenarioId: "s2",
        poNumber: "PO-2",
      });
    });

    test("a draft is not what the client holds, so it is not accepted", async () => {
      const quote = await create();

      await expect(
        acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId: draftOf(quote).id,
          scenarioId: "s1",
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("an expired version is not accepted", async () => {
      const { versionId } = await sent();
      await db
        .update(quoteVersions)
        .set({ validUntil: "2026-09-01" })
        .where(eq(quoteVersions.id, versionId));

      await expect(
        acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId,
          scenarioId: "s1",
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("a scenario the version does not offer is refused", async () => {
      const { versionId } = await sent();

      await expect(
        acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId,
          scenarioId: "s9",
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("an optional item of another scenario is refused", async () => {
      const { versionId } = await sent();

      await expect(
        acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId,
          scenarioId: "s1",
          optionalLineIds: ["other"],
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("a document stored outside the team is refused", async () => {
      const { versionId } = await sent();

      await expect(
        acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId,
          scenarioId: "s1",
          acceptanceFilePath: [TEAM_EUR_ID, "quotes", "order-form.pdf"],
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("another team's version is not accepted", async () => {
      const { versionId } = await sent();

      expect(
        await acceptQuoteVersion(db, {
          teamId: TEAM_EUR_ID,
          versionId,
          scenarioId: "s1",
          today: TODAY,
        }),
      ).toBeNull();
    });

    test("a draft left open beside the accepted version is not sent", async () => {
      const { quoteId, versionId } = await sent();
      // The revision is drafted before the answer comes in.
      const revised = await reviseQuote(db, {
        teamId: TEAM_USD_ID,
        quoteId,
      });
      const draft = draftOf(revised!);
      await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId,
        scenarioId: "s1",
        today: TODAY,
      });

      await expect(
        markQuoteVersionSent(db, {
          teamId: TEAM_USD_ID,
          versionId: draft.id,
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("an accepted version is still the one the list shows as held", async () => {
      const { versionId } = await sent();
      await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId,
        scenarioId: "s1",
        today: TODAY,
      });

      const [row] = await listQuotes(db, {
        teamId: TEAM_USD_ID,
        today: TODAY,
      });
      expect(row!.held).toMatchObject({ id: versionId, status: "accepted" });
    });

    test("the file kept for a version is read back with its name", async () => {
      const { versionId } = await sent();

      expect(
        await getQuoteVersionFile(db, { teamId: TEAM_USD_ID, versionId }),
      ).toEqual({
        pdfPath: [TEAM_USD_ID, "quotes", "kept.pdf"],
        quoteNumber: "OFF-0001",
        version: 1,
      });
      expect(
        await getQuoteVersionFile(db, { teamId: TEAM_EUR_ID, versionId }),
      ).toBeNull();
    });
  });

  /**
   * FF-1616. General terms only bind if the client could know them before
   * the contract was concluded (Civil Code art. 5.23), so every sent version
   * records which version went with it, and the PDF names it.
   */
  describe("general terms", () => {
    const file = (name: string) => ({
      filePath: [TEAM_USD_ID, "quotes", name],
      fileName: "terms.pdf",
    });

    async function add(label: string, language: "nl" | "en", name = label) {
      return addQuoteTerms(db, {
        teamId: TEAM_USD_ID,
        label,
        language,
        ...file(name),
      });
    }

    test("versions come back newest first, each with its language", async () => {
      await add("2025-01", "en");
      await add("2026-01", "en");
      await add("2026-01", "nl");

      expect(
        (await listQuoteTerms(db, { teamId: TEAM_USD_ID })).map(
          (row) => `${row.label} ${row.language}`,
        ),
      ).toEqual(["2026-01 nl", "2026-01 en", "2025-01 en"]);
    });

    test("the same version twice in one language is refused", async () => {
      await add("2026-01", "en");
      await expect(add("2026-01", "en", "again")).rejects.toBeInstanceOf(
        QuoteInputError,
      );
    });

    test("a file stored outside the team is refused", async () => {
      await expect(
        addQuoteTerms(db, {
          teamId: TEAM_USD_ID,
          label: "2026-01",
          language: "en",
          filePath: [TEAM_EUR_ID, "quotes", "terms.pdf"],
          fileName: "terms.pdf",
        }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("sending records the newest version in the quote's language", async () => {
      await add("2025-01", "en");
      const current = await add("2026-01", "en");
      await add("2026-06", "nl");

      const quote = await create({ language: "en" });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
      });

      const sentVersion = (await getQuote(db, {
        id: quote.id,
        teamId: TEAM_USD_ID,
      }))!.versions[0]!;
      expect(sentVersion.termsVersionId).toBe(current.id);
    });

    test("no terms in that language, none recorded", async () => {
      await add("2026-01", "nl");
      const quote = await create({ language: "en" });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
      });

      const sentVersion = (await getQuote(db, {
        id: quote.id,
        teamId: TEAM_USD_ID,
      }))!.versions[0]!;
      expect(sentVersion.termsVersionId).toBeNull();
    });

    test("the PDF names the version that went out", async () => {
      await add("2026-01", "en");
      const quote = await create({ language: "en" });
      const draft = draftOf(quote);
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });

      const input = await getQuotePdfInput(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
      });
      expect(input!.termsLabel).toBe("2026-01");
    });

    test("a draft is drawn with the terms it would be sent with", async () => {
      await add("2026-01", "en");
      const quote = await create({ language: "en" });

      const input = await getQuotePdfInput(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
      });
      expect(input!.termsLabel).toBe("2026-01");
    });

    test("a version nobody was sent is removed", async () => {
      const terms = await add("2026-01", "en");

      expect(
        await deleteQuoteTerms(db, { teamId: TEAM_USD_ID, id: terms.id }),
      ).not.toBeNull();
      expect(await listQuoteTerms(db, { teamId: TEAM_USD_ID })).toHaveLength(0);
    });

    test("one a quote was sent with stays", async () => {
      const terms = await add("2026-01", "en");
      const quote = await create({ language: "en" });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draftOf(quote).id,
      });

      await expect(
        deleteQuoteTerms(db, { teamId: TEAM_USD_ID, id: terms.id }),
      ).rejects.toBeInstanceOf(QuoteInputError);
    });

    test("another team's version is not removed", async () => {
      const terms = await add("2026-01", "en");

      expect(
        await deleteQuoteTerms(db, { teamId: TEAM_EUR_ID, id: terms.id }),
      ).toBeNull();
      expect(await listQuoteTerms(db, { teamId: TEAM_USD_ID })).toHaveLength(1);
    });
  });

  /**
   * FF-1617. An accepted quote becomes a tracker project with a budget, so
   * quoted and tracked hours can be compared from day one. A project holds
   * one rate and an estimate in whole hours.
   */
  describe("the tracker project an accepted quote becomes", () => {
    /** One scenario of 10 hours at 100, with a 5-hour optional item. */
    function content(productId: string): QuoteContent {
      const item = (id: string, hours: number, optional: boolean) => ({
        id,
        type: "item" as const,
        title: `Work ${id}`,
        description: null,
        productId,
        hours,
        hoursMax: null,
        optional,
        once: false,
      });
      return {
        blocks: [{ id: "b1", type: "pricing" }],
        rates: { productRates: {}, volumeTiers: [], termTiers: [] },
        displayUnit: "hours",
        hoursPerDay: 8,
        scenarios: [
          {
            id: "s1",
            name: "Fixed price",
            recommended: true,
            pricing: "fixed",
            capped: false,
            recurrence: null,
            adjustmentOverride: null,
            paymentSchedule: [],
            lines: [item("base", 10, false), item("extra", 5, true)],
          },
        ],
      };
    }

    async function accepted(
      optionalLineIds: string[] = [],
      storePdf?: StoreQuotePdf,
    ) {
      const product = await createInvoiceProduct(db, {
        teamId: TEAM_USD_ID,
        createdBy: TEST_USER_ID,
        name: "Development",
        price: 100,
        currency: "USD",
        unit: "hour",
      });
      const quote = await create();
      const draft = draftOf(quote);
      await updateQuoteDraft(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        content: content(product.id),
      });
      await markQuoteVersionSent(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        storePdf,
      });
      const after = await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId: draft.id,
        scenarioId: "s1",
        optionalLineIds,
        today: TODAY,
      });
      return { quote: after!, versionId: draft.id };
    }

    async function projectOf(id: string) {
      const [row] = await db
        .select()
        .from(trackerProjects)
        .where(eq(trackerProjects.id, id));
      return row!;
    }

    test("carries the quote's name, customer and currency, and its budget", async () => {
      const { quote } = await accepted();

      expect(quote.trackerProjectId).not.toBeNull();
      expect(await projectOf(quote.trackerProjectId!)).toMatchObject({
        teamId: TEAM_USD_ID,
        name: "Maintenance proposal",
        description: "OFF-0001",
        customerId,
        currency: "USD",
        billable: true,
        estimate: 10,
        rate: 100,
      });
    });

    test("counts the optional items that were taken", async () => {
      const { quote } = await accepted(["extra"]);

      expect(await projectOf(quote.trackerProjectId!)).toMatchObject({
        estimate: 15,
        rate: 100,
      });
    });

    test("accepting again moves the same project, not a second one", async () => {
      const { quote, versionId } = await accepted();
      const first = quote.trackerProjectId!;
      await db
        .update(trackerProjects)
        .set({ name: "Renamed in the tracker" })
        .where(eq(trackerProjects.id, first));

      const again = await acceptQuoteVersion(db, {
        teamId: TEAM_USD_ID,
        versionId,
        scenarioId: "s1",
        optionalLineIds: ["extra"],
        today: TODAY,
      });

      expect(again!.trackerProjectId).toBe(first);
      // A rename in the tracker survives a corrected answer.
      expect(await projectOf(first)).toMatchObject({
        name: "Renamed in the tracker",
      });
      // Counted by the quote it names: the seed has projects of its own.
      expect(
        await db
          .select()
          .from(trackerProjects)
          .where(eq(trackerProjects.description, "OFF-0001")),
      ).toHaveLength(1);
      expect(await projectOf(first)).toMatchObject({ estimate: 15 });
    });

    // FF-1636: a quote won by mistake had no route back — a won quote hides
    // both Revise and the Outcome menu, so only what was *recorded* could be
    // corrected, never the win itself.
    describe("taking an acceptance back", () => {
      async function versionOf(id: string) {
        const [row] = await db
          .select()
          .from(quoteVersions)
          .where(eq(quoteVersions.id, id));
        return row!;
      }

      test("puts the version back to sent and the quote back to open", async () => {
        const { versionId } = await accepted(["extra"]);

        const after = await undoQuoteAcceptance(db, {
          teamId: TEAM_USD_ID,
          versionId,
          today: TODAY,
        });

        expect(after).toMatchObject({ outcome: "open", outcomeAt: null });
        expect(await versionOf(versionId)).toMatchObject({
          status: "sent",
          acceptedScenarioId: null,
          acceptedOptionalLineIds: null,
          acceptedAt: null,
          acceptedByName: null,
          poNumber: null,
          acceptanceFilePath: null,
        });
      });

      // Time may already be booked against it, which would be worse to lose
      // than the wrong answer is to keep.
      test("leaves the tracker project standing, and still linked", async () => {
        const { quote, versionId } = await accepted();
        const project = quote.trackerProjectId!;

        const after = await undoQuoteAcceptance(db, {
          teamId: TEAM_USD_ID,
          versionId,
          today: TODAY,
        });

        expect(after!.trackerProjectId).toBe(project);
        expect(await projectOf(project)).toMatchObject({ estimate: 10 });
      });

      // Because the link survives, the second answer corrects the first
      // project rather than leaving a stray one behind.
      test("accepting again moves that same project", async () => {
        const { quote, versionId } = await accepted();
        const project = quote.trackerProjectId!;

        await undoQuoteAcceptance(db, {
          teamId: TEAM_USD_ID,
          versionId,
          today: TODAY,
        });
        const again = await acceptQuoteVersion(db, {
          teamId: TEAM_USD_ID,
          versionId,
          scenarioId: "s1",
          optionalLineIds: ["extra"],
          today: TODAY,
        });

        expect(again).toMatchObject({ outcome: "won" });
        expect(again!.trackerProjectId).toBe(project);
        expect(
          await db
            .select()
            .from(trackerProjects)
            .where(eq(trackerProjects.description, "OFF-0001")),
        ).toHaveLength(1);
      });

      // The client holds it; withdrawing the answer does not unsend it.
      test("keeps the PDF that was stored when it was sent", async () => {
        const { versionId } = await accepted([], async () => [
          TEAM_USD_ID,
          "quotes",
          "kept.pdf",
        ]);
        const before = await versionOf(versionId);
        expect(before.pdfPath).toEqual([TEAM_USD_ID, "quotes", "kept.pdf"]);

        await undoQuoteAcceptance(db, {
          teamId: TEAM_USD_ID,
          versionId,
          today: TODAY,
        });

        expect((await versionOf(versionId)).pdfPath).toEqual(before.pdfPath);
      });

      test("refuses a version nobody has accepted", async () => {
        const quote = await create();

        expect(
          undoQuoteAcceptance(db, {
            teamId: TEAM_USD_ID,
            versionId: draftOf(quote).id,
            today: TODAY,
          }),
        ).rejects.toThrow(QuoteInputError);
      });

      test("is null for a version of another team", async () => {
        const { versionId } = await accepted();

        expect(
          await undoQuoteAcceptance(db, {
            teamId: TEAM_EUR_ID,
            versionId,
            today: TODAY,
          }),
        ).toBeNull();
      });
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
