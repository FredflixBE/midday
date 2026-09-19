/**
 * Seam under test: how a transaction finds its supplier — rules first, the
 * model only for what they leave, and the model's answer kept as a rule
 * (FF-1555).
 *
 * The model is a stand-in that records what it was asked, because the claims
 * worth holding are about *when* it is asked: once per new supplier, never for
 * a payment a rule already answers, and never again after a correction.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml; see
 * suppliers.test.ts for how to run it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  type KnownSupplier,
  type RecognisableTransaction,
  recogniseSuppliers,
  type SupplierAnswer,
  type SupplierQuestion,
} from "../queries/supplier-recognition";
import {
  getSupplierRules,
  saveSupplierRule,
  setTransactionSupplier,
} from "../queries/suppliers";
import { suppliers, transactions } from "../schema";
import { BANK_USD_CHECKING_ID, seedAll, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

let sequence = 0;

/** A model that answers from a table keyed on the transaction text's start. */
function fakeModel(answers: Record<string, SupplierAnswer | null>) {
  const asked: SupplierQuestion[] = [];
  const shown: KnownSupplier[][] = [];

  const ask = async (
    questions: SupplierQuestion[],
    known: readonly KnownSupplier[],
  ) => {
    asked.push(...questions);
    shown.push([...known]);
    return questions.map((question) => {
      const key = Object.keys(answers).find((start) =>
        question.name.startsWith(start),
      );
      return key ? answers[key] : null;
    });
  };

  return { ask, asked, shown };
}

const byText = (supplier: string, span: string): SupplierAnswer => ({
  supplier,
  confidence: 0.9,
  namedBy: "text",
  span,
});

const byCounterparty = (supplier: string): SupplierAnswer => ({
  supplier,
  confidence: 0.9,
  namedBy: "counterparty",
  span: null,
});

describe.skipIf(SKIP)("supplier recognition", () => {
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
  ): Promise<RecognisableTransaction> {
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
        internalId: `ff1555-r-${sequence}-${Math.random()}`,
        status: "posted",
        ...overrides,
      })
      .returning({
        id: transactions.id,
        name: transactions.name,
        counterpartyName: transactions.counterpartyName,
        counterpartyIban: transactions.counterpartyIban,
        merchantName: transactions.merchantName,
        description: transactions.description,
        amount: transactions.amount,
        internal: transactions.internal,
      });
    return row!;
  }

  async function linkOf(id: string) {
    const [row] = await db
      .select({
        supplierId: transactions.supplierId,
        supplierLink: transactions.supplierLink,
        supplierName: suppliers.name,
      })
      .from(transactions)
      .leftJoin(suppliers, eq(suppliers.id, transactions.supplierId))
      .where(eq(transactions.id, id));
    return row!;
  }

  test("the model's answer becomes a rule, so next month's payment needs no model", async () => {
    const model = fakeModel({
      Xerius: byText("Xerius", "Xerius Be2000 Antwerpen"),
    });
    const december = await payment({
      name: "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart 28 12 2025",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [december],
      ask: model.ask,
    });

    expect(await linkOf(december.id)).toMatchObject({
      supplierName: "Xerius",
      supplierLink: "rule",
    });

    const march = await payment({
      name: "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart 28 03 2026",
    });
    const result = await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [march],
      ask: model.ask,
    });

    expect(model.asked).toHaveLength(1);
    expect(result.asked).toBe(0);
    expect(result.suppliers.get(march.id)?.name).toBe("Xerius");
  });

  test("one question per counterparty, answered for all of its payments", async () => {
    const model = fakeModel({ Telenet: byCounterparty("Telenet BV") });
    const a = await payment({
      name: "Telenet Bv Domiciliëring 1173",
      counterpartyName: "Telenet Bv",
    });
    const b = await payment({
      name: "Telenet Bv Domiciliëring 1174",
      counterpartyName: "Telenet Bv",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [a, b],
      ask: model.ask,
    });

    expect(model.asked).toHaveLength(1);
    expect((await linkOf(a.id)).supplierName).toBe("Telenet BV");
    expect((await linkOf(b.id)).supplierName).toBe("Telenet BV");

    const rules = await getSupplierRules(db, { teamId: TEAM_USD_ID });
    expect(rules.map((rule) => [rule.field, rule.value, rule.source])).toEqual([
      ["counterparty_name", "telenet bv", "enrichment"],
    ]);
  });

  test("two spellings the model names as one company land on one supplier", async () => {
    const model = fakeModel({
      "Kbc Verzekeringen Domiciliëring": byCounterparty("KBC Verzekeringen NV"),
      "331722856258": byCounterparty("KBC Verzekeringen NV"),
    });
    const a = await payment({
      name: "Kbc Verzekeringen Domiciliëring 398380377905",
      counterpartyName: "Kbc Verzekeringen",
    });
    const b = await payment({
      name: "331722856258",
      counterpartyName: "Kbc Verzekeringen Nv",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [a, b],
      ask: model.ask,
    });

    expect((await linkOf(a.id)).supplierId).toBe(
      (await linkOf(b.id)).supplierId,
    );
    expect(await db.select().from(suppliers)).toHaveLength(1);
  });

  test("a collective counterparty is not grouped on, and never becomes a rule", async () => {
    const model = fakeModel({
      "Le Quai Son": byText("QS Exploitation", "Le Quai Son"),
      Horbo: byText("Horbo", "Horbo"),
    });
    await saveSupplierRule(db, {
      teamId: TEAM_USD_ID,
      supplierId: null,
      field: "counterparty_name",
      value: "Diverse leveranciers Restaurant",
    });

    const quai = await payment({
      name: "Le Quai Son Antwerpen BEL",
      counterpartyName: "Diverse leveranciers Restaurant",
    });
    const horbo = await payment({
      name: "Horbo Reet BEL",
      counterpartyName: "Diverse leveranciers Restaurant",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [quai, horbo],
      ask: model.ask,
    });

    expect((await linkOf(quai.id)).supplierName).toBe("QS Exploitation");
    expect((await linkOf(horbo.id)).supplierName).toBe("Horbo");
  });

  test("a payment an answer's rule does not reach is asked about itself, not handed the guess", async () => {
    // Both SumUp terminals share a merchant name, so they are one question —
    // but the answer's span only fits the taxi. The café is asked in the next
    // round instead of becoming the taxi driver's.
    const model = fakeModel({
      "SumUp KIMAKH": byText("Kimakh Wahib", "SumUp KIMAKH WAHIB"),
      "SumUp Cafe": byText("Cafe Mokka", "SumUp Cafe Mokka"),
    });
    const taxi = await payment({
      name: "SumUp KIMAKH WAHIB Paris FRA",
      merchantName: "SumUp Payments Ltd",
    });
    const cafe = await payment({
      name: "SumUp Cafe Mokka Luxembourg LUX",
      merchantName: "SumUp Payments Ltd",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [taxi, cafe],
      ask: model.ask,
    });

    expect(model.asked).toHaveLength(2);
    expect((await linkOf(taxi.id)).supplierName).toBe("Kimakh Wahib");
    expect((await linkOf(cafe.id)).supplierName).toBe("Cafe Mokka");
  });

  test("a span the text does not start with is not stored, and the answer is kept as a visible guess", async () => {
    const model = fakeModel({
      Xerius: byText("KBC Bank NV", "Kbc Debetkaart"),
    });
    const card = await payment({
      name: "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart",
    });

    const result = await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [card],
      ask: model.ask,
    });

    expect(await getSupplierRules(db, { teamId: TEAM_USD_ID })).toHaveLength(0);
    expect(result.guessed).toBe(1);
    expect(await linkOf(card.id)).toMatchObject({
      supplierName: "KBC Bank NV",
      supplierLink: "ai",
    });
  });

  test("a correction is never re-asked about or overwritten", async () => {
    const model = fakeModel({ Xerius: byText("KBC Bank NV", "Xerius") });
    const card = await payment({ name: "Xerius Be2000 Antwerpen Betaling" });
    const [right] = await db
      .insert(suppliers)
      .values({ teamId: TEAM_USD_ID, name: "Xerius" })
      .returning();

    await setTransactionSupplier(db, {
      teamId: TEAM_USD_ID,
      transactionId: card.id,
      supplierId: right!.id,
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [card],
      ask: model.ask,
    });

    expect(model.asked).toHaveLength(0);
    expect(await linkOf(card.id)).toMatchObject({
      supplierName: "Xerius",
      supplierLink: "person",
    });
  });

  test("income, own-account transfers and unsure answers create nothing", async () => {
    const model = fakeModel({
      Refund: byCounterparty("Somebody"),
      Transfer: byCounterparty("Fredflix BV"),
      Unsure: { ...byCounterparty("Maybe Ltd"), confidence: 0.3 },
    });
    const income = await payment({ name: "Refund from customer", amount: 50 });
    const own = await payment({ name: "Transfer to savings", internal: true });
    const unsure = await payment({
      name: "Unsure Payment",
      counterpartyName: "Maybe",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [income, own, unsure],
      ask: model.ask,
    });

    expect(model.asked.map((question) => question.name)).toEqual([
      "Unsure Payment",
    ]);
    expect(await db.select().from(suppliers)).toHaveLength(0);
  });

  test("the IBAN the bank sent is kept as a rule beside the name", async () => {
    const model = fakeModel({ "Sd Worx": byCounterparty("SD Worx VZW") });
    const salaryAgency = await payment({
      name: "Sd Worx Sociaal Secretariaat Vzw Overschrijving",
      counterpartyName: "Sd Worx Sociaal Secretariaat Vzw",
      counterpartyIban: "BE82 4100 0144 0168",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [salaryAgency],
      ask: model.ask,
    });

    const rules = await getSupplierRules(db, { teamId: TEAM_USD_ID });
    expect(rules.map((rule) => [rule.field, rule.value]).sort()).toEqual([
      ["counterparty_iban", "BE82410001440168"],
      ["counterparty_name", "sd worx sociaal secretariaat vzw"],
    ]);
  });

  test("a processor's account is not kept as a rule when the text names the supplier", async () => {
    // A SEPA debit collected by a processor carries the processor's IBAN. As a
    // rule it would outrank everything and hand every later payment through
    // that processor to this one merchant.
    const model = fakeModel({
      Mollie: byText("Cafe Mokka", "Mollie Cafe Mokka"),
    });
    const collected = await payment({
      name: "Mollie Cafe Mokka Order 7731",
      counterpartyName: "Stichting Mollie Payments",
      counterpartyIban: "NL55 ABNA 0000 0000 00",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [collected],
      ask: model.ask,
    });

    const rules = await getSupplierRules(db, { teamId: TEAM_USD_ID });
    expect(rules.map((rule) => rule.field)).toEqual(["name"]);
  });

  test("a rule the model writes reaches the payments an earlier run left behind", async () => {
    // The first leasing payment was asked about in one run and the model was
    // unsure; a later run learnt the rule. The earlier one must follow.
    const unsure = fakeModel({
      Betaling: { ...byText("KBC Lease", "Betaling Leasing"), confidence: 0.2 },
    });
    const earlier = await payment({
      name: "Betaling Leasing 0001 0001 Be 2601573144",
    });
    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [earlier],
      ask: unsure.ask,
    });
    expect((await linkOf(earlier.id)).supplierId).toBeNull();

    const sure = fakeModel({
      Betaling: byText("KBC Lease", "Betaling Leasing"),
    });
    const later = await payment({
      name: "Betaling Leasing 0001 0001 Be 2602692352",
    });
    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [later],
      ask: sure.ask,
    });

    expect((await linkOf(earlier.id)).supplierName).toBe("KBC Lease");
  });

  test("the model is shown the suppliers that exist, and naming one by an alias creates nothing", async () => {
    // Merging Xerius into its legal name kept "Xerius" as an alias. The model,
    // shown the list, answers with the short name again; that must land on the
    // merged supplier, not bring the duplicate back.
    const [xerius] = await db
      .insert(suppliers)
      .values({
        teamId: TEAM_USD_ID,
        name: "Xerius Sociaal Verzekeringsfonds VZW",
        aliases: ["Xerius"],
      })
      .returning();
    await db
      .insert(suppliers)
      .values({ teamId: TEAM_USD_ID, name: "Telenet BV" });

    const model = fakeModel({ Xerius: byText("Xerius", "Xerius Be2000") });
    const card = await payment({
      name: "Xerius Be2000 Antwerpen Betaling Met Kbc Debetkaart",
    });

    const result = await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [card],
      ask: model.ask,
    });

    expect(model.shown[0]).toEqual([
      { name: "Telenet BV", aliases: [] },
      { name: "Xerius Sociaal Verzekeringsfonds VZW", aliases: ["Xerius"] },
    ]);
    expect(result.created).toBe(0);
    expect((await linkOf(card.id)).supplierId).toBe(xerius!.id);
    expect(await db.select().from(suppliers)).toHaveLength(2);
  });

  test("a supplier the model creates is shown to it in the next round", async () => {
    // Same SumUp merchant, two terminals: round one creates the taxi driver,
    // round two asks about the café and must already see him.
    const model = fakeModel({
      "SumUp KIMAKH": byText("Kimakh Wahib", "SumUp KIMAKH WAHIB"),
      "SumUp Cafe": byText("Cafe Mokka", "SumUp Cafe Mokka"),
    });
    const taxi = await payment({
      name: "SumUp KIMAKH WAHIB Paris FRA",
      merchantName: "SumUp Payments Ltd",
    });
    const cafe = await payment({
      name: "SumUp Cafe Mokka Luxembourg LUX",
      merchantName: "SumUp Payments Ltd",
    });

    await recogniseSuppliers(db, {
      teamId: TEAM_USD_ID,
      transactions: [taxi, cafe],
      ask: model.ask,
    });

    expect(model.shown).toEqual([[], [{ name: "Kimakh Wahib", aliases: [] }]]);
  });
});
