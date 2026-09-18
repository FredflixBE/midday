/**
 * Seam under test: suppliers, their rules, and the link on a transaction
 * (FF-1555).
 *
 * What the ticket is done by: a supplier exists as a record, a transaction
 * points at one, a correction survives the next run, and two rows that turn
 * out to be one company can be merged. Each has a test here.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/suppliers.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import {
  applySupplierRules,
  createSupplier,
  deleteSupplier,
  deleteSupplierRule,
  findOrCreateSupplier,
  getCategoriesBySupplier,
  getSupplierRules,
  getSuppliers,
  linkTransactionsByGuess,
  mergeSuppliers,
  previewSupplierRule,
  resetTransactionSupplier,
  SupplierMergeError,
  SupplierNameTakenError,
  saveSupplierRule,
  setTransactionSupplier,
  updateSupplier,
} from "../queries/suppliers";
import { supplierRules, suppliers, transactions } from "../schema";
import {
  BANK_USD_CHECKING_ID,
  seedAll,
  TEAM_EUR_ID,
  TEAM_USD_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const SOFTWARE = "10000000-0000-0000-0000-000000000010";

let sequence = 0;

describe.skipIf(SKIP)("suppliers", () => {
  let db: Database;

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    await db.delete(transactions).where(eq(transactions.teamId, TEAM_USD_ID));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function payment(
    overrides: Partial<typeof transactions.$inferInsert> = {},
  ): Promise<string> {
    sequence++;
    const [row] = await db
      .insert(transactions)
      .values({
        date: "2026-03-01",
        name: "Payment",
        method: "other",
        amount: -100,
        currency: "USD",
        teamId: TEAM_USD_ID,
        bankAccountId: BANK_USD_CHECKING_ID,
        internalId: `ff1555-${sequence}-${Math.random()}`,
        status: "posted",
        ...overrides,
      })
      .returning({ id: transactions.id });
    return row!.id;
  }

  async function linkOf(id: string) {
    const [row] = await db
      .select({
        supplierId: transactions.supplierId,
        supplierRuleId: transactions.supplierRuleId,
        supplierLink: transactions.supplierLink,
      })
      .from(transactions)
      .where(eq(transactions.id, id));
    return row!;
  }

  async function supplier(name: string) {
    return createSupplier(db, { teamId: TEAM_USD_ID, name });
  }

  describe("the entity", () => {
    test("a supplier's name is unique per team, whatever its case", async () => {
      await supplier("Cursor Inc");

      await expect(supplier("CURSOR INC")).rejects.toBeInstanceOf(
        SupplierNameTakenError,
      );
      // Another team is another namespace.
      await createSupplier(db, { teamId: TEAM_EUR_ID, name: "Cursor Inc" });
    });

    test("find-or-create lands on the existing row, so two runs make one supplier", async () => {
      const first = await findOrCreateSupplier(db, {
        teamId: TEAM_USD_ID,
        name: "Cursor Inc",
        source: "enrichment",
      });
      const again = await Promise.all([
        findOrCreateSupplier(db, {
          teamId: TEAM_USD_ID,
          name: "cursor  inc",
          source: "enrichment",
        }),
        findOrCreateSupplier(db, {
          teamId: TEAM_USD_ID,
          name: "Cursor Inc",
          source: "enrichment",
        }),
      ]);

      expect(first.created).toBe(true);
      expect(again.map((r) => r.supplier.id)).toEqual([
        first.supplier.id,
        first.supplier.id,
      ]);
    });

    test("renaming into another supplier's name is refused, and says to merge", async () => {
      await supplier("Xerius");
      const other = await supplier("Xerius Sociaal Verzekeringsfonds");

      await expect(
        updateSupplier(db, {
          teamId: TEAM_USD_ID,
          id: other.id,
          name: "xerius",
        }),
      ).rejects.toBeInstanceOf(SupplierNameTakenError);
    });

    test("a default category must be one of the team's own", async () => {
      await expect(
        createSupplier(db, {
          teamId: TEAM_EUR_ID,
          name: "Cursor Inc",
          defaultCategoryId: SOFTWARE,
        }),
      ).rejects.toThrow();
    });

    test("the list counts the payments and rules behind each supplier", async () => {
      const cursor = await supplier("Cursor Inc");
      await payment({ name: "CURSOR AI POWERED IDE SAN FRANCISCO CA" });
      await payment({ name: "CURSOR USAGE DEC NEW YORK NY" });
      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: cursor.id,
        field: "name",
        value: "CURSOR",
      });

      const [row] = await getSuppliers(db, { teamId: TEAM_USD_ID });

      expect(row).toMatchObject({
        name: "Cursor Inc",
        transactionCount: 2,
        ruleCount: 1,
      });
    });
  });

  describe("rules", () => {
    test("saving a rule links the history it matches, and says which rule did", async () => {
      const xerius = await supplier("Xerius");
      const card = await payment({
        name: "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart Via Bancontact",
      });
      const kbc = await payment({ name: "Kbc Mastercard Afrekening 174" });

      const { rule, applied } = await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: xerius.id,
        field: "name",
        value: "Xerius Be2000 Antwerpen",
      });

      expect(applied.linked).toBe(1);
      expect(await linkOf(card)).toEqual({
        supplierId: xerius.id,
        supplierRuleId: rule.id,
        supplierLink: "rule",
      });
      expect((await linkOf(kbc)).supplierId).toBeNull();
    });

    test("saving the same text again re-points the rule instead of adding a second", async () => {
      const one = await supplier("KBC Bank NV");
      const two = await supplier("KBC Verzekeringen NV");
      const policy = await payment({ counterpartyName: "Kbc Verzekeringen" });

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: one.id,
        field: "counterparty_name",
        value: "Kbc Verzekeringen",
      });
      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: two.id,
        field: "counterparty_name",
        value: "KBC  verzekeringen",
      });

      expect(await getSupplierRules(db, { teamId: TEAM_USD_ID })).toHaveLength(
        1,
      );
      expect((await linkOf(policy)).supplierId).toBe(two.id);
    });

    test("deleting a rule hands its payments to the next rule, or to nobody", async () => {
      const sumup = await supplier("SumUp Payments Ltd");
      const taxi = await supplier("Kimakh Wahib");
      const ride = await payment({ name: "SumUp KIMAKH WAHIB Paris FRA" });
      const cafe = await payment({ name: "SumUp Cafe Luxembourg LUX" });

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: sumup.id,
        field: "name",
        value: "SumUp",
      });
      const { rule: specific } = await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: taxi.id,
        field: "name",
        value: "SumUp KIMAKH WAHIB",
      });

      expect((await linkOf(ride)).supplierId).toBe(taxi.id);
      expect((await linkOf(cafe)).supplierId).toBe(sumup.id);

      await deleteSupplierRule(db, { teamId: TEAM_USD_ID, id: specific.id });
      expect((await linkOf(ride)).supplierId).toBe(sumup.id);

      const [general] = await getSupplierRules(db, { teamId: TEAM_USD_ID });
      await deleteSupplierRule(db, { teamId: TEAM_USD_ID, id: general!.id });
      expect(await linkOf(ride)).toEqual({
        supplierId: null,
        supplierRuleId: null,
        supplierLink: null,
      });
    });

    test("a rule overtakes a guess the model made on its own, and never a person's choice", async () => {
      const guessed = await supplier("Guessed Ltd");
      const chosen = await supplier("Chosen BV");
      const telenet = await supplier("Telenet BV");
      const byGuess = await payment({ name: "Telenet Bv Domiciliëring 1173" });
      const byPerson = await payment({ name: "Telenet Bv Domiciliëring 1174" });

      await linkTransactionsByGuess(db, {
        teamId: TEAM_USD_ID,
        supplierId: guessed.id,
        transactionIds: [byGuess],
      });
      await setTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: byPerson,
        supplierId: chosen.id,
      });

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: telenet.id,
        field: "name",
        value: "Telenet Bv Domiciliering",
      });

      expect(await linkOf(byGuess)).toMatchObject({
        supplierId: telenet.id,
        supplierLink: "rule",
      });
      expect(await linkOf(byPerson)).toEqual({
        supplierId: chosen.id,
        supplierRuleId: null,
        supplierLink: "person",
      });
    });

    test("a guess no rule answers for is left alone, not dropped", async () => {
      const guessed = await supplier("Guessed Ltd");
      const id = await payment({ name: "Something only the model knew" });

      await linkTransactionsByGuess(db, {
        teamId: TEAM_USD_ID,
        supplierId: guessed.id,
        transactionIds: [id],
      });
      await applySupplierRules(db, { teamId: TEAM_USD_ID });

      expect(await linkOf(id)).toMatchObject({
        supplierId: guessed.id,
        supplierLink: "ai",
      });
    });

    test("a collective name links nobody, and the text is read instead", async () => {
      const cafe = await supplier("QS Exploitation");
      const id = await payment({
        name: "Le Quai Son Antwerpen BEL",
        counterpartyName: "Diverse leveranciers Restaurant",
      });

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: null,
        field: "counterparty_name",
        value: "Diverse leveranciers Restaurant",
      });
      expect((await linkOf(id)).supplierId).toBeNull();

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: cafe.id,
        field: "name",
        value: "Le Quai Son",
      });
      expect((await linkOf(id)).supplierId).toBe(cafe.id);
    });
  });

  describe("the preview", () => {
    test("shows what a rule would take, including from another supplier and from a person", async () => {
      const bank = await supplier("KBC Bank NV");
      const leasing = await supplier("KBC Lease Belgium");
      const person = await supplier("Somebody Chose This");

      const leaseA = await payment({
        name: "Betaling Leasing 0001 Be 2600825238",
      });
      const leaseB = await payment({
        name: "Betaling Leasing 0001 Be 2600461094",
      });
      const chosen = await payment({
        name: "Betaling Leasing 0001 Be 2502981850",
      });
      await payment({ name: "Kbc Mastercard Afrekening 174" });

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: bank.id,
        field: "name",
        value: "Betaling Leasing 0001 Be 2600825238",
      });
      await setTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: chosen,
        supplierId: person.id,
      });

      const preview = await previewSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: leasing.id,
        field: "name",
        value: "Betaling Leasing",
      });

      const effects = Object.fromEntries(
        preview.rows.map((row) => [row.id, row.effect]),
      );

      expect(preview.total).toBe(3);
      // Already the bank's by a longer, more specific rule: it stays there.
      expect(effects[leaseA]).toBe("outranked");
      expect(effects[leaseB]).toBe("link");
      expect(effects[chosen]).toBe("kept");
      // Nothing is saved by a preview.
      expect((await linkOf(leaseB)).supplierId).toBeNull();
    });

    test("names the supplier a payment would be taken from", async () => {
      const guessed = await supplier("Guessed Ltd");
      const real = await supplier("Real Ltd");
      const id = await payment({ name: "Real Ltd Invoice 44" });
      await linkTransactionsByGuess(db, {
        teamId: TEAM_USD_ID,
        supplierId: guessed.id,
        transactionIds: [id],
      });

      const preview = await previewSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: real.id,
        field: "name",
        value: "Real Ltd",
      });

      expect(preview.rows[0]).toMatchObject({
        effect: "move",
        currentSupplier: { id: guessed.id, name: "Guessed Ltd" },
        currentLink: "ai",
      });
    });
  });

  describe("a correction", () => {
    test("survives every later rule change, and can be handed back", async () => {
      const wrong = await supplier("KBC Bank NV");
      const right = await supplier("Xerius");
      const id = await payment({
        name: "Xerius Be2000 Antwerpen Betaling Met Kbc",
      });

      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: wrong.id,
        field: "name",
        value: "Xerius",
      });
      await setTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: id,
        supplierId: right.id,
      });
      await applySupplierRules(db, { teamId: TEAM_USD_ID });

      expect(await linkOf(id)).toMatchObject({
        supplierId: right.id,
        supplierLink: "person",
      });

      await resetTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: id,
      });
      expect(await linkOf(id)).toMatchObject({
        supplierId: wrong.id,
        supplierLink: "rule",
      });
    });

    test("'no supplier' is a choice too, and holds", async () => {
      const salary = await supplier("Fredflix BV");
      const id = await payment({ counterpartyName: "Fredflix Bv" });
      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: salary.id,
        field: "counterparty_name",
        value: "Fredflix Bv",
      });

      await setTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: id,
        supplierId: null,
      });
      await applySupplierRules(db, { teamId: TEAM_USD_ID });

      expect(await linkOf(id)).toEqual({
        supplierId: null,
        supplierRuleId: null,
        supplierLink: "person",
      });
    });

    test("cannot point a payment at another team's supplier", async () => {
      const foreign = await createSupplier(db, {
        teamId: TEAM_EUR_ID,
        name: "Elsewhere",
      });
      const id = await payment();

      await expect(
        setTransactionSupplier(db, {
          teamId: TEAM_USD_ID,
          transactionId: id,
          supplierId: foreign.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe("merging", () => {
    test("moves payments and rules to the supplier kept, and fills only what it lacks", async () => {
      const kept = await createSupplier(db, {
        teamId: TEAM_USD_ID,
        name: "Xerius Sociaal Verzekeringsfonds VZW",
        vatNumber: "BE0409.080.608",
      });
      const merged = await createSupplier(db, {
        teamId: TEAM_USD_ID,
        name: "Xerius",
        vatNumber: "BE0000.000.000",
        defaultCategoryId: SOFTWARE,
        source: "enrichment",
      });

      const byRule = await payment({
        name: "Xerius Be2000 Antwerpen Betaling",
      });
      const byPerson = await payment({ name: "525150420256" });
      await saveSupplierRule(db, {
        teamId: TEAM_USD_ID,
        supplierId: merged.id,
        field: "name",
        value: "Xerius Be2000",
      });
      await setTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: byPerson,
        supplierId: merged.id,
      });

      const result = await mergeSuppliers(db, {
        teamId: TEAM_USD_ID,
        sourceId: merged.id,
        targetId: kept.id,
      });

      expect(result.movedTransactions).toBe(2);
      expect(result.supplier).toMatchObject({
        vatNumber: "BE0409.080.608",
        defaultCategoryId: SOFTWARE,
      });
      expect(await linkOf(byRule)).toMatchObject({
        supplierId: kept.id,
        supplierLink: "rule",
      });
      expect(await linkOf(byPerson)).toMatchObject({
        supplierId: kept.id,
        supplierLink: "person",
      });

      const rules = await db
        .select()
        .from(supplierRules)
        .where(eq(supplierRules.teamId, TEAM_USD_ID));
      expect(rules.map((rule) => rule.supplierId)).toEqual([kept.id]);

      const gone = await db
        .select()
        .from(suppliers)
        .where(inArray(suppliers.id, [merged.id]));
      expect(gone).toHaveLength(0);

      // A later payment in the merged spelling finds the kept supplier.
      const later = await payment({ name: "Xerius Be2000 Antwerpen Betaling" });
      await applySupplierRules(db, {
        teamId: TEAM_USD_ID,
        transactionIds: [later],
      });
      expect((await linkOf(later)).supplierId).toBe(kept.id);
    });

    test("refuses two suppliers linked to different contacts in the books", async () => {
      const a = await supplier("A");
      const b = await supplier("B");
      await db
        .update(suppliers)
        .set({ externalId: "guid-a" })
        .where(eq(suppliers.id, a.id));
      await db
        .update(suppliers)
        .set({ externalId: "guid-b" })
        .where(eq(suppliers.id, b.id));

      await expect(
        mergeSuppliers(db, {
          teamId: TEAM_USD_ID,
          sourceId: a.id,
          targetId: b.id,
        }),
      ).rejects.toBeInstanceOf(SupplierMergeError);
    });

    test("refuses a supplier from another team", async () => {
      const mine = await supplier("Mine");
      const theirs = await createSupplier(db, {
        teamId: TEAM_EUR_ID,
        name: "Theirs",
      });

      await expect(
        mergeSuppliers(db, {
          teamId: TEAM_USD_ID,
          sourceId: theirs.id,
          targetId: mine.id,
        }),
      ).rejects.toBeInstanceOf(SupplierMergeError);
    });
  });

  test("deleting a supplier hands every payment back to recognition", async () => {
    const doomed = await supplier("Doomed");
    const other = await supplier("Other");
    const byPerson = await payment({ name: "Other Ltd 1" });
    await saveSupplierRule(db, {
      teamId: TEAM_USD_ID,
      supplierId: other.id,
      field: "name",
      value: "Other Ltd",
    });
    await setTransactionSupplier(db, {
      teamId: TEAM_USD_ID,
      transactionId: byPerson,
      supplierId: doomed.id,
    });

    await deleteSupplier(db, { teamId: TEAM_USD_ID, id: doomed.id });

    expect(await linkOf(byPerson)).toMatchObject({
      supplierId: other.id,
      supplierLink: "rule",
    });
  });

  describe("remembered categories", () => {
    test("the supplier's own default wins over its history", async () => {
      const cursor = await createSupplier(db, {
        teamId: TEAM_USD_ID,
        name: "Cursor Inc",
        defaultCategoryId: SOFTWARE,
      });
      const id = await payment({ categorySlug: "travel" });
      await setTransactionSupplier(db, {
        teamId: TEAM_USD_ID,
        transactionId: id,
        supplierId: cursor.id,
      });

      const answers = await getCategoriesBySupplier(db, {
        teamId: TEAM_USD_ID,
        supplierIds: [cursor.id],
      });

      expect(answers.get(cursor.id)).toBe("software");
    });

    test("without a default, a consistent history answers and a split one does not", async () => {
      const agreed = await supplier("Agreed");
      const split = await supplier("Split");

      for (const [supplierId, categorySlug] of [
        [agreed.id, "software"],
        [agreed.id, "software"],
        [split.id, "software"],
        [split.id, "travel"],
      ] as const) {
        const id = await payment({ categorySlug });
        await setTransactionSupplier(db, {
          teamId: TEAM_USD_ID,
          transactionId: id,
          supplierId,
        });
      }

      const answers = await getCategoriesBySupplier(db, {
        teamId: TEAM_USD_ID,
        supplierIds: [agreed.id, split.id],
      });

      expect(answers.get(agreed.id)).toBe("software");
      expect(answers.has(split.id)).toBe(false);
    });
  });
});
