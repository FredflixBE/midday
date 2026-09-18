import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  notInArray,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../client";
import { commitments, suppliers, transactions } from "../schema";
import {
  type Cadence,
  type CommitmentKind,
  type DetectedSeries,
  detectSeries,
  extendsSeries,
  kindOf,
  nextOccurrence,
  type PriceKind,
  type SeriesPayment,
} from "../utils/commitment-series";
import { isReversedSql } from "./invoice-status";

/**
 * Recurring commitments (FF-1591, ADR-48): detect the rhythm behind a
 * supplier's payments, propose it, and let a person correct it.
 *
 * Three rules from FF-1555 hold throughout. A person overrules detection: it
 * never edits a commitment after proposing it, and never moves a payment a
 * person placed. A wrong answer stays visible: a rejected proposal is kept,
 * with its payments, rather than deleted and proposed again. And every figure
 * decomposes: a commitment carries the payments it was read from.
 */

export type CommitmentStatus = "proposed" | "active" | "rejected" | "ended";

/** The payments a commitment could be read from, for one supplier. */
type Candidate = SeriesPayment & {
  supplierId: string;
  categorySlug: string | null;
  method: string;
};

/**
 * What can be one occurrence of a commitment: money going out to a supplier,
 * not a transfer between the team's own accounts, not one that came straight
 * back (FF-1567), and not a card settlement.
 *
 * The settlement is the trap. The monthly Mastercard payment is marked
 * internal only once the books' card statement arrives, and until then it is
 * an ordinary expense to KBC Bank — counting it beside the card charges it
 * pays counts a month of card spend twice. Its category is what gives it away
 * before the statement does.
 */
const CARD_SETTLEMENT_CATEGORY = "credit-card-payment";

function eligibleSql(teamId: string, supplierIds?: string[]) {
  return and(
    eq(transactions.teamId, teamId),
    isNotNull(transactions.supplierId),
    supplierIds ? inArray(transactions.supplierId, supplierIds) : undefined,
    sql`${transactions.amount} < 0`,
    ne(sql`coalesce(${transactions.internal}, false)`, true),
    notInArray(transactions.status, ["pending", "excluded", "archived"]),
    sql`coalesce(${transactions.categorySlug}, '') <> ${CARD_SETTLEMENT_CATEGORY}`,
    not(isReversedSql(teamId)),
  );
}

const candidateColumns = {
  id: transactions.id,
  date: transactions.date,
  amount: transactions.amount,
  currency: transactions.currency,
  originalAmount: transactions.originalAmount,
  originalCurrency: transactions.originalCurrency,
  supplierId: transactions.supplierId,
  categorySlug: transactions.categorySlug,
  method: transactions.method,
  commitmentId: transactions.commitmentId,
  commitmentLink: transactions.commitmentLink,
};

type CandidateRow = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  supplierId: string | null;
  categorySlug: string | null;
  method: string;
  commitmentId: string | null;
  commitmentLink: "detected" | "person" | null;
};

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    originalAmount: row.originalAmount,
    originalCurrency: row.originalCurrency,
    supplierId: row.supplierId!,
    categorySlug: row.categorySlug,
    method: row.method,
  };
}

type Known = {
  id: string;
  supplierId: string;
  cadence: Cadence;
  priceKind: PriceKind;
  billedCurrency: string | null;
  /** Its most recent payment, which a later one has to follow. */
  last: SeriesPayment | null;
};

export type CommitmentProposal = {
  supplierId: string;
  kind: CommitmentKind;
  series: DetectedSeries;
};

export type CommitmentPlan = {
  /** Payments that continue a commitment that already exists. */
  attach: { transactionId: string; commitmentId: string }[];
  /** New series, to be proposed. */
  propose: CommitmentProposal[];
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What detection would do, without doing it — the dry run the history script
 * prints, and the first half of `detectCommitments`.
 *
 * Per supplier: first every payment no commitment holds yet is offered to the
 * supplier's existing commitments, oldest first, so next month's Cursor charge
 * joins Cursor's commitment rather than starting a second one. A commitment of
 * any status takes them — a rejected one too, so a series a person turned down
 * is not proposed again the month after, and an ended one, so a charge after
 * its end date is on record as exactly that. Then what is still loose is read
 * for new series.
 */
export async function planCommitments(
  db: DatabaseOrTransaction,
  params: { teamId: string; supplierIds?: string[]; today?: string },
): Promise<CommitmentPlan> {
  const { teamId } = params;
  const plan: CommitmentPlan = { attach: [], propose: [] };

  if (params.supplierIds?.length === 0) return plan;

  const rows: CandidateRow[] = await db
    .select(candidateColumns)
    .from(transactions)
    .where(eligibleSql(teamId, params.supplierIds))
    .orderBy(asc(transactions.date), asc(transactions.id));

  const existing = await db
    .select({
      id: commitments.id,
      supplierId: commitments.supplierId,
      cadence: commitments.cadence,
      priceKind: commitments.priceKind,
      billedCurrency: commitments.billedCurrency,
    })
    .from(commitments)
    .where(
      and(
        eq(commitments.teamId, teamId),
        params.supplierIds
          ? inArray(commitments.supplierId, params.supplierIds)
          : undefined,
      ),
    );

  const byId = new Map<string, Known>();
  const bySupplier = new Map<string, Known[]>();
  for (const commitment of existing) {
    const entry: Known = { ...commitment, last: null };
    byId.set(entry.id, entry);
    bySupplier.set(entry.supplierId, [
      ...(bySupplier.get(entry.supplierId) ?? []),
      entry,
    ]);
  }

  const loose = new Map<string, Candidate[]>();

  for (const row of rows) {
    // Held already, whoever put it there: it is the commitment's most recent
    // payment so far, because rows run oldest first.
    if (row.commitmentId) {
      const entry = byId.get(row.commitmentId);
      if (entry) entry.last = toCandidate(row);
      continue;
    }

    // A person said this payment belongs to no commitment.
    if (row.commitmentLink === "person") continue;

    const candidate = toCandidate(row);
    const target = continued(
      bySupplier.get(candidate.supplierId) ?? [],
      candidate,
    );

    if (target) {
      plan.attach.push({
        transactionId: candidate.id,
        commitmentId: target.id,
      });
      target.last = candidate;
      continue;
    }

    const list = loose.get(candidate.supplierId) ?? [];
    list.push(candidate);
    loose.set(candidate.supplierId, list);
  }

  for (const [supplierId, payments] of loose) {
    for (const series of detectSeries(payments, {
      today: params.today ?? today(),
    })) {
      const ids = new Set(series.payments.map((p) => p.id));
      plan.propose.push({
        supplierId,
        kind: kindOf(payments.filter((p) => ids.has(p.id))),
        series,
      });
    }
  }

  return plan;
}

/** The existing commitment this payment continues, the closest price first. */
function continued(candidates: Known[], payment: SeriesPayment): Known | null {
  const fits = candidates.filter(
    (one) => one.last && extendsSeries(one, one.last, payment),
  );

  const distance = (one: Known) =>
    Math.abs(Math.abs(one.last!.amount) - Math.abs(payment.amount));

  return fits.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

export type DetectedCommitments = {
  attached: number;
  proposed: number;
};

/**
 * Attach what continues a commitment, and propose what is new. Written in one
 * transaction, so a proposal never exists without the payments it was read
 * from.
 *
 * Only touches payments nothing holds: a payment already in a commitment, or
 * one a person took out of every commitment, is never moved.
 */
export async function detectCommitments(
  db: Database,
  params: { teamId: string; supplierIds?: string[]; today?: string },
): Promise<DetectedCommitments> {
  return db.transaction(async (tx) => {
    const plan = await planCommitments(tx, params);

    for (const { transactionId, commitmentId } of plan.attach) {
      await linkDetected(tx, params.teamId, [transactionId], commitmentId);
    }

    for (const { supplierId, kind, series } of plan.propose) {
      const [commitment] = await tx
        .insert(commitments)
        .values({
          teamId: params.teamId,
          supplierId,
          kind,
          cadence: series.cadence,
          day: series.day,
          priceKind: series.priceKind,
          amount: series.amount,
          currency: series.currency,
          amountLow: series.amountLow,
          amountHigh: series.amountHigh,
          billedAmount: series.billedAmount,
          billedCurrency: series.billedCurrency,
          status: "proposed",
        })
        .returning({ id: commitments.id });

      await linkDetected(
        tx,
        params.teamId,
        series.payments.map((p) => p.id),
        commitment!.id,
      );
    }

    return { attached: plan.attach.length, proposed: plan.propose.length };
  });
}

async function linkDetected(
  db: DatabaseOrTransaction,
  teamId: string,
  transactionIds: string[],
  commitmentId: string,
) {
  await db
    .update(transactions)
    .set({ commitmentId, commitmentLink: "detected" })
    .where(
      and(
        eq(transactions.teamId, teamId),
        inArray(transactions.id, transactionIds),
        // Re-checked here, not only when planned: a person's answer that
        // landed in between wins.
        isNull(transactions.commitmentLink),
      ),
    );
}

export type CommitmentPayment = {
  id: string;
  date: string;
  name: string;
  amount: number;
  currency: string;
  /** How the payment's supplier was set; `ai` is the model's guess alone. */
  supplierLink: "rule" | "ai" | "person" | null;
};

export type Commitment = {
  id: string;
  supplierId: string;
  supplierName: string;
  kind: CommitmentKind;
  cadence: Cadence;
  day: number;
  priceKind: PriceKind;
  amount: number;
  currency: string;
  amountLow: number | null;
  amountHigh: number | null;
  billedAmount: number | null;
  billedCurrency: string | null;
  status: CommitmentStatus;
  endsOn: string | null;
  /** Oldest first: what every figure above decomposes into. */
  payments: CommitmentPayment[];
  /**
   * How many of them are linked to the supplier on the model's word alone
   * (FF-1555). A series read from guesses is only as good as the guesses.
   */
  guessed: number;
  /** When the next one is due, or null when nothing is predicted. */
  nextDate: string | null;
};

/**
 * A team's commitments, or one supplier's, with the payments behind each.
 *
 * `nextDate` is only given for a commitment that is predicted: proposed or
 * active, with a payment to count from, and not past its end date.
 */
export async function getCommitments(
  db: DatabaseOrTransaction,
  params: { teamId: string; supplierId?: string },
): Promise<Commitment[]> {
  const rows = await db
    .select({
      id: commitments.id,
      supplierId: commitments.supplierId,
      supplierName: suppliers.name,
      kind: commitments.kind,
      cadence: commitments.cadence,
      day: commitments.day,
      priceKind: commitments.priceKind,
      amount: commitments.amount,
      currency: commitments.currency,
      amountLow: commitments.amountLow,
      amountHigh: commitments.amountHigh,
      billedAmount: commitments.billedAmount,
      billedCurrency: commitments.billedCurrency,
      status: commitments.status,
      endsOn: commitments.endsOn,
    })
    .from(commitments)
    .innerJoin(suppliers, eq(suppliers.id, commitments.supplierId))
    .where(
      and(
        eq(commitments.teamId, params.teamId),
        params.supplierId
          ? eq(commitments.supplierId, params.supplierId)
          : undefined,
      ),
    )
    .orderBy(asc(suppliers.name), asc(commitments.createdAt));

  if (rows.length === 0) return [];

  const payments = await db
    .select({
      id: transactions.id,
      commitmentId: transactions.commitmentId,
      date: transactions.date,
      name: transactions.name,
      amount: transactions.amount,
      currency: transactions.currency,
      supplierLink: transactions.supplierLink,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        inArray(
          transactions.commitmentId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(transactions.date), asc(transactions.id));

  const byCommitment = new Map<string, CommitmentPayment[]>();
  for (const { commitmentId, ...payment } of payments) {
    const list = byCommitment.get(commitmentId!) ?? [];
    list.push(payment);
    byCommitment.set(commitmentId!, list);
  }

  return rows.map((row) => {
    const own = byCommitment.get(row.id) ?? [];
    const last = own.at(-1);
    const predicted = row.status === "proposed" || row.status === "active";
    const next =
      predicted && last
        ? nextOccurrence(last.date, row.cadence, row.day)
        : null;

    return {
      ...row,
      payments: own,
      guessed: own.filter((p) => p.supplierLink === "ai").length,
      nextDate: next && (!row.endsOn || next <= row.endsOn) ? next : null,
    };
  });
}

export class CommitmentInputError extends Error {}

export type UpdateCommitmentParams = {
  teamId: string;
  id: string;
  kind?: CommitmentKind;
  cadence?: Cadence;
  day?: number;
  priceKind?: PriceKind;
  amount?: number;
  amountLow?: number | null;
  amountHigh?: number | null;
  status?: CommitmentStatus;
  endsOn?: string | null;
};

/**
 * A person's correction: confirm, reject, end, or fix what detection read.
 * Ending one without a date ends it today.
 */
export async function updateCommitment(
  db: DatabaseOrTransaction,
  params: UpdateCommitmentParams,
) {
  const { teamId, id, ...patch } = params;

  if (patch.day !== undefined && (patch.day < 1 || patch.day > 31)) {
    throw new CommitmentInputError("A day of the month is 1 to 31");
  }

  const endsOn =
    patch.status === "ended" && patch.endsOn === undefined
      ? today()
      : patch.endsOn;

  const [row] = await db
    .update(commitments)
    .set({ ...patch, ...(endsOn !== undefined ? { endsOn } : {}) })
    .where(and(eq(commitments.id, id), eq(commitments.teamId, teamId)))
    .returning();

  return row ?? null;
}

/**
 * A person's answer for one payment: this commitment, or none. Final, like a
 * person's supplier — detection never moves it again.
 */
export async function setTransactionCommitment(
  db: DatabaseOrTransaction,
  params: {
    teamId: string;
    transactionId: string;
    commitmentId: string | null;
  },
) {
  if (params.commitmentId) {
    const [commitment] = await db
      .select({ id: commitments.id })
      .from(commitments)
      .where(
        and(
          eq(commitments.id, params.commitmentId),
          eq(commitments.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!commitment) {
      throw new CommitmentInputError(
        "That commitment does not belong to this team",
      );
    }
  }

  const [row] = await db
    .update(transactions)
    .set({ commitmentId: params.commitmentId, commitmentLink: "person" })
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.teamId, params.teamId),
      ),
    )
    .returning({ id: transactions.id });

  return row ?? null;
}
