import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { supplierRules, suppliers, transactions } from "../schema";
import { counterpartyKey } from "../utils/counterparty";
import { leadingSpanRule, normaliseRuleValue } from "../utils/supplier-rules";
import {
  applySupplierRules,
  findOrCreateSupplier,
  insertSupplierRuleIfAbsent,
  linkTransactionsByGuess,
} from "./suppliers";

/**
 * How a transaction finds its supplier (FF-1555): deterministic first, the
 * model only where nothing deterministic answers, and **the model's answer is
 * stored as a rule rather than applied once**.
 *
 * 1. **Already linked** — by a person, a rule, or an earlier guess.
 * 2. **A stored rule** — the IBAN, the counterparty name, a leading span of
 *    the text. No model call.
 * 3. **The model**, for the rest, once per counterparty. It names the supplier
 *    and says which part of the transaction names it; that part becomes a rule,
 *    so the next payment from the same supplier is step 2.
 *
 * So the model's cost scales with new suppliers, not with transactions — about
 * 59 in the first year here and near zero a month after. If that stops being
 * true, recognition has drifted back to per-transaction.
 *
 * The model is passed in rather than called here, so this package stays free
 * of an AI dependency and the whole path can be tested against a database.
 */

/** What the model is shown about one counterparty. */
export type SupplierQuestion = {
  name: string;
  counterpartyName: string | null;
  merchantName: string | null;
  description: string | null;
};

/** What it answers. */
export type SupplierAnswer = {
  /** The legal entity paid, or null when it cannot tell. */
  supplier: string | null;
  confidence: number;
  /**
   * Which part of the transaction names the supplier. `counterparty` only when
   * the counterparty field is that company itself — never a collective bucket
   * like `Diverse leveranciers Restaurant`, or a payment processor.
   */
  namedBy: "counterparty" | "text" | null;
  /** When named by the text: the leading span of it that is the supplier. */
  span: string | null;
};

export type AskSuppliers = (
  questions: SupplierQuestion[],
) => Promise<(SupplierAnswer | null | undefined)[]>;

/** Below this the model's supplier is not used at all. */
export const SUPPLIER_CONFIDENCE_MIN = 0.6;

/**
 * How many times one run goes back to the model. A second round only happens
 * for payments an answer's rule did not reach — a collective counterparty, a
 * payment processor's terminal — and a third is rarer still; the bound keeps a
 * pathological batch from asking forever.
 */
const MAX_ROUNDS = 3;

export type RecognisableTransaction = {
  id: string;
  name: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  merchantName: string | null;
  description: string | null;
  amount: number;
  internal: boolean | null;
};

export type SupplierRecognition = {
  /** Transaction id → the supplier it now points at, for every linked row. */
  suppliers: Map<string, { id: string; name: string }>;
  /** Counterparties the model was asked about. */
  asked: number;
  /** Suppliers the model's answers created. */
  created: number;
  /** Rows linked on the model's word alone, with no rule to show for it. */
  guessed: number;
};

type Group = { key: string; transactions: RecognisableTransaction[] };

/**
 * Recognise the supplier of each of these transactions, asking the model about
 * whatever the rules cannot answer.
 *
 * Only money going out is sent to the model, and not a transfer between the
 * team's own accounts: a supplier is someone the business pays. The rules still
 * apply to everything, so a refund from a supplier is recognised as theirs.
 *
 * A failing model call is thrown to the caller, after the deterministic links
 * are written — they needed no model and are kept either way.
 */
export async function recogniseSuppliers(
  db: DatabaseOrTransaction,
  params: {
    teamId: string;
    transactions: RecognisableTransaction[];
    ask: AskSuppliers;
  },
): Promise<SupplierRecognition> {
  const { teamId } = params;
  const ids = params.transactions.map((transaction) => transaction.id);
  const result: SupplierRecognition = {
    suppliers: new Map(),
    asked: 0,
    created: 0,
    guessed: 0,
  };

  if (ids.length === 0) return result;

  await applySupplierRules(db, { teamId, transactionIds: ids });

  const collective = await collectiveCounterparties(db, teamId);
  const candidates = params.transactions.filter(
    (transaction) => transaction.amount < 0 && !transaction.internal,
  );

  // The rows the model has been shown itself. A group's answer covers the rest
  // of it only through a rule; a payment the rule did not reach is asked about
  // in its own right next round, rather than handed a neighbour's guess.
  const shown = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const open = new Set(
      await stillUnlinked(
        db,
        teamId,
        candidates.map((transaction) => transaction.id),
      ),
    );

    const groups = groupForSupplierQuestions(
      candidates.filter(
        (transaction) => open.has(transaction.id) && !shown.has(transaction.id),
      ),
      collective,
    );

    if (groups.length === 0) break;

    result.asked += groups.length;

    const answers = await params.ask(
      groups.map((group) => toQuestion(group.transactions[0]!)),
    );

    // One group at a time, re-reading what is still unlinked before each: a
    // rule the first answer stored may already have linked the next group,
    // and asking it to add a second rule would only give the two a chance to
    // disagree.
    for (const [index, group] of groups.entries()) {
      const asked = group.transactions[0]!;
      shown.add(asked.id);

      const answer = answers[index];

      if (!answer?.supplier || answer.confidence < SUPPLIER_CONFIDENCE_MIN) {
        continue;
      }

      const pendingIds = await stillUnlinked(
        db,
        teamId,
        group.transactions.map((transaction) => transaction.id),
      );
      if (pendingIds.length === 0) continue;

      const pending = group.transactions.filter((transaction) =>
        pendingIds.includes(transaction.id),
      );

      const { supplier, created } = await findOrCreateSupplier(db, {
        teamId,
        name: answer.supplier,
        source: "enrichment",
      });
      if (created) result.created++;

      for (const rule of rulesFromAnswer(pending, answer)) {
        await insertSupplierRuleIfAbsent(db, {
          teamId,
          supplierId: supplier.id,
          field: rule.field,
          value: rule.value,
          source: "enrichment",
        });
      }

      await applySupplierRules(db, { teamId, transactionIds: pendingIds });

      // The payment the model actually read still gets its answer when no
      // rule could be kept for it, marked as a guess so it reads as one.
      if (pendingIds.includes(asked.id)) {
        result.guessed += await linkTransactionsByGuess(db, {
          teamId,
          supplierId: supplier.id,
          transactionIds: await stillUnlinked(db, teamId, [asked.id]),
        });
      }
    }
  }

  const linked = await db
    .select({
      id: transactions.id,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
    })
    .from(transactions)
    .innerJoin(suppliers, eq(suppliers.id, transactions.supplierId))
    .where(and(eq(transactions.teamId, teamId), inArray(transactions.id, ids)));

  for (const row of linked) {
    result.suppliers.set(row.id, {
      id: row.supplierId,
      name: row.supplierName,
    });
  }

  return result;
}

/**
 * The rules one answer is kept as.
 *
 * - The IBAN of each payment, where the bank sent one: the account paid is the
 *   strongest identifier there is, and it survives a trading name the text does
 *   not share.
 * - The counterparty name, when the model says that field names the supplier.
 * - Otherwise a leading span of each payment's text, when the model's span is
 *   one — see `leadingSpanRule` for what is refused.
 */
export function rulesFromAnswer(
  pending: RecognisableTransaction[],
  answer: SupplierAnswer,
): {
  field: "counterparty_iban" | "counterparty_name" | "name";
  value: string;
}[] {
  const rules = new Map<
    string,
    { field: "counterparty_iban" | "counterparty_name" | "name"; value: string }
  >();

  const add = (
    field: "counterparty_iban" | "counterparty_name" | "name",
    value: string | null,
  ) => {
    if (value) rules.set(`${field}:${value}`, { field, value });
  };

  for (const transaction of pending) {
    add(
      "counterparty_iban",
      normaliseRuleValue("counterparty_iban", transaction.counterpartyIban),
    );

    if (answer.namedBy === "counterparty" && transaction.counterpartyName) {
      add(
        "counterparty_name",
        normaliseRuleValue("counterparty_name", transaction.counterpartyName),
      );
    } else if (answer.namedBy === "text") {
      add("name", leadingSpanRule(transaction.name, answer.span));
    }
  }

  return [...rules.values()];
}

/**
 * One question per counterparty, not one per payment — the same reason as the
 * categoriser's grouping (FF-1554).
 *
 * The key is the counterparty together with the first word of the text, not
 * the counterparty alone. A collective bucket like `Diverse leveranciers
 * Restaurant` covers many restaurants, and grouping on it would apply one
 * restaurant's answer to all of them; their texts start differently, so they
 * are asked separately. Ordinary counterparties lose nothing — `Google Cloud
 * EMEA Limited` is `google …` on every charge — and a first word with no letter
 * in it (the reference numbers the bank puts on a tax payment) is left out of
 * the key so those still group.
 *
 * A counterparty a person has already marked as naming nobody is not grouped
 * on at all.
 */
export function groupForSupplierQuestions(
  transactions: RecognisableTransaction[],
  collective: Set<string>,
): Group[] {
  const groups = new Map<string, Group>();

  for (const transaction of transactions) {
    const counterparty = normaliseRuleValue(
      "counterparty_name",
      transaction.counterpartyName,
    );
    const usable =
      counterparty && !collective.has(counterparty)
        ? counterpartyKey(transaction)
        : counterpartyKey({
            counterpartyName: null,
            merchantName: transaction.merchantName,
          });

    const firstWord =
      normaliseRuleValue("name", transaction.name)?.split(" ")[0] ?? "";
    const lead = /\p{L}/u.test(firstWord) ? firstWord : "";

    const key = usable ? `${usable}|${lead}` : `alone:${transaction.id}`;

    const group = groups.get(key);
    if (group) group.transactions.push(transaction);
    else groups.set(key, { key, transactions: [transaction] });
  }

  return [...groups.values()];
}

function toQuestion(transaction: RecognisableTransaction): SupplierQuestion {
  return {
    name: transaction.name,
    counterpartyName: transaction.counterpartyName,
    merchantName: transaction.merchantName,
    description: transaction.description,
  };
}

async function stillUnlinked(
  db: DatabaseOrTransaction,
  teamId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, teamId),
        inArray(transactions.id, ids),
        isNull(transactions.supplierLink),
      ),
    );

  return rows.map((row) => row.id);
}

/** Counterparty names a rule says name nobody. */
async function collectiveCounterparties(
  db: DatabaseOrTransaction,
  teamId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ value: supplierRules.value })
    .from(supplierRules)
    .where(
      and(
        eq(supplierRules.teamId, teamId),
        eq(supplierRules.field, "counterparty_name"),
        isNull(supplierRules.supplierId),
      ),
    );

  return new Set(rows.map((row) => row.value));
}
