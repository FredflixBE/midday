import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
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
 *    It is shown the suppliers that already exist, so a second spelling of
 *    one lands on it instead of becoming a duplicate (FF-1603).
 *    A party it could not name is remembered on the payment and not asked
 *    about again until a rule or a person links that payment (FF-1600).
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

/**
 * A supplier that already exists, shown to the model so it answers with that
 * name rather than a second spelling of it (FF-1603).
 */
export type KnownSupplier = { name: string; aliases: string[] };

export type AskSuppliers = (
  questions: SupplierQuestion[],
  known: readonly KnownSupplier[],
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

/**
 * How many existing suppliers are loaded to show the model — about 60 today,
 * plus whatever one run creates. Past the
 * bound the ones paid least often are left out, and a new spelling of one of
 * those becomes a duplicate again — which a merge folds back, keeping the
 * spelling as an alias so it does not recur.
 */
export const KNOWN_SUPPLIERS_MAX = 300;

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
  /**
   * Payments not asked about because the model already could not name their
   * party, in an earlier run or earlier in this one (FF-1600).
   */
  notAskedAgain: number;
};

/** A group's key is null when nothing names its party; see `questionKey`. */
type Group = { key: string | null; transactions: RecognisableTransaction[] };

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
    notAskedAgain: 0,
  };

  if (ids.length === 0) return result;

  await applySupplierRules(db, { teamId, transactionIds: ids });

  const collective = await collectiveCounterparties(db, teamId);
  const known = await knownSuppliers(db, teamId);
  const unanswered = await unansweredParties(db, teamId, collective);

  const outgoing = params.transactions.filter(
    (transaction) => transaction.amount < 0 && !transaction.internal,
  );
  const isUnanswered = (transaction: RecognisableTransaction) => {
    const key = questionKey(transaction, collective);
    return (
      unanswered.ids.has(transaction.id) ||
      (key !== null && unanswered.keys.has(key))
    );
  };
  const candidates = outgoing.filter(
    (transaction) => !isUnanswered(transaction),
  );

  // The rows the model has been shown itself. A group's answer covers the rest
  // of it only through a rule; a payment the rule did not reach is asked about
  // in its own right next round, rather than handed a neighbour's guess.
  const shown = new Set<string>();
  let rulesCreated = 0;

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
        (transaction) =>
          open.has(transaction.id) &&
          !shown.has(transaction.id) &&
          // Again, not only up front: an answer this run may have added a key.
          !isUnanswered(transaction),
      ),
      collective,
    );

    if (groups.length === 0) break;

    result.asked += groups.length;

    const answers = await params.ask(
      groups.map((group) => toQuestion(group.transactions[0]!)),
      known,
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
        // An answer that says it cannot tell is remembered, so neither the
        // rest of this group in a later round nor the party's next payment is
        // asked the same question again. A missing answer is the model
        // failing, not answering, and is asked again next time.
        if (answer) {
          await markUnanswered(db, teamId, asked.id);
          if (group.key !== null) unanswered.keys.add(group.key);
        }
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
      if (created) {
        result.created++;
        // So a later round answers with it too.
        known.push({ name: supplier.name, aliases: supplier.aliases });
      }

      for (const rule of rulesFromAnswer(pending, answer)) {
        const inserted = await insertSupplierRuleIfAbsent(db, {
          teamId,
          supplierId: supplier.id,
          field: rule.field,
          value: rule.value,
          source: "enrichment",
        });
        if (inserted) rulesCreated++;
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

  // A rule the model wrote is a rule like any other: it reaches every payment
  // no person has decided, not only the ones in this run. Without this, the
  // first leasing payment taught Midday the rule and the ten before it never
  // heard about it.
  if (rulesCreated > 0) {
    await applySupplierRules(db, { teamId });
  }

  const skipped = outgoing.filter(
    (transaction) => !shown.has(transaction.id) && isUnanswered(transaction),
  );
  result.notAskedAgain = (
    await stillUnlinked(
      db,
      teamId,
      skipped.map((transaction) => transaction.id),
    )
  ).length;

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
 * - The IBAN of each payment, where the bank sent one — but only when the
 *   model says the counterparty is the supplier. The account paid is the
 *   strongest identifier there is, and it outranks every other rule, which is
 *   exactly why it must not be kept when the counterparty is a payment
 *   processor collecting for someone else: its account would then send every
 *   later payment through that processor to this one merchant.
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
    if (answer.namedBy === "counterparty") {
      add(
        "counterparty_iban",
        normaliseRuleValue("counterparty_iban", transaction.counterpartyIban),
      );
    }

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
    const key = questionKey(transaction, collective);
    const slot = key ?? `alone:${transaction.id}`;

    const group = groups.get(slot);
    if (group) group.transactions.push(transaction);
    else groups.set(slot, { key, transactions: [transaction] });
  }

  return [...groups.values()];
}

/**
 * The party a payment is asked about as, or null when nothing names one — a
 * payment with neither a counterparty nor a merchant is asked about alone.
 */
function questionKey(
  transaction: Pick<
    RecognisableTransaction,
    "name" | "counterpartyName" | "merchantName"
  >,
  collective: Set<string>,
): string | null {
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

  if (!usable) return null;

  const firstWord =
    normaliseRuleValue("name", transaction.name)?.split(" ")[0] ?? "";
  const lead = /\p{L}/u.test(firstWord) ? firstWord : "";

  return `${usable}|${lead}`;
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

/**
 * The parties the model could not name (FF-1600): every payment it said it
 * could not tell about, while nothing has given that payment a supplier. A
 * party is the key questions are grouped on — the counterparty, or merchant,
 * with the first word of the text.
 *
 * Read from the payments rather than kept as a list of its own. Whatever
 * links the marked payment clears its mark, and a person naming the supplier
 * of any payment from that party ends the memory for all of them, so the
 * model — now shown that supplier — is asked again.
 */
async function unansweredParties(
  db: DatabaseOrTransaction,
  teamId: string,
  collective: Set<string>,
): Promise<{ ids: Set<string>; keys: Set<string> }> {
  const party = {
    id: transactions.id,
    name: transactions.name,
    counterpartyName: transactions.counterpartyName,
    merchantName: transactions.merchantName,
  };

  const [marked, named] = await Promise.all([
    db
      .select(party)
      .from(transactions)
      .where(
        and(
          eq(transactions.teamId, teamId),
          isNotNull(transactions.supplierUnansweredAt),
          isNull(transactions.supplierId),
        ),
      ),
    db
      .select(party)
      .from(transactions)
      .where(
        and(
          eq(transactions.teamId, teamId),
          eq(transactions.supplierLink, "person"),
          isNotNull(transactions.supplierId),
        ),
      ),
  ]);

  const namedByPerson = new Set(
    named.map((row) => questionKey(row, collective)),
  );

  const keys = new Set<string>();
  for (const row of marked) {
    const key = questionKey(row, collective);
    if (key !== null && !namedByPerson.has(key)) keys.add(key);
  }

  return { ids: new Set(marked.map((row) => row.id)), keys };
}

async function markUnanswered(
  db: DatabaseOrTransaction,
  teamId: string,
  transactionId: string,
) {
  await db
    .update(transactions)
    .set({ supplierUnansweredAt: sql`now()` })
    .where(
      and(eq(transactions.teamId, teamId), eq(transactions.id, transactionId)),
    );
}

/** The team's suppliers, the most often paid first, up to the bound. */
async function knownSuppliers(
  db: DatabaseOrTransaction,
  teamId: string,
): Promise<KnownSupplier[]> {
  const payments = count(transactions.id);

  return db
    .select({ name: suppliers.name, aliases: suppliers.aliases })
    .from(suppliers)
    .leftJoin(
      transactions,
      and(
        eq(transactions.supplierId, suppliers.id),
        eq(transactions.teamId, teamId),
      ),
    )
    .where(eq(suppliers.teamId, teamId))
    .groupBy(suppliers.id)
    .orderBy(desc(payments), asc(suppliers.name))
    .limit(KNOWN_SUPPLIERS_MAX);
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
