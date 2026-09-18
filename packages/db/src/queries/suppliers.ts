import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  supplierRules,
  suppliers,
  transactionCategories,
  transactions,
} from "../schema";
import {
  normaliseRuleValue,
  normaliseSupplierName,
  resolveSupplier,
  ruleMatches,
  type SupplierRuleField,
  type SupplierRuleForMatching,
} from "../utils/supplier-rules";
import { UNCATEGORIZED } from "./transaction-enrichment";

/**
 * Suppliers, the rules that recognise them, and the link on a transaction
 * (FF-1555).
 *
 * ## The three rules this answers to
 *
 * 1. **A human can overwrite anything the AI decides.** A person's link is
 *    `supplier_link = 'person'`, and nothing here ever moves one.
 * 2. **The AI may be wrong, as long as a human can see it.** Every automatic
 *    link says what made it — a rule, named, or the model on its own.
 * 3. **Anything aggregated must be decomposable.** A supplier's count is the
 *    rows that point at it, nothing cached.
 *
 * ## Editing a rule re-links history
 *
 * Decided here, deliberately, because the ticket left it open. A rule applies
 * to every payment a person has not decided, past and future, so a
 * transaction that says "matched by rule X" is always one rule X matches
 * today. Forward-only would leave history linked by rules that no longer say
 * so, and the rule table would stop being a true account of the links. The
 * preview is what makes this safe: it lists what a rule would take, including
 * payments that would move away from another supplier.
 */

export type SupplierSource = "manual" | "enrichment";

/** The link a person set, or the one automation is allowed to redo. */
type LinkState = {
  supplierId: string | null;
  supplierRuleId: string | null;
  supplierLink: "rule" | "ai" | "person" | null;
};

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export class SupplierNameTakenError extends Error {
  constructor(name: string) {
    super(
      `A supplier named "${name}" already exists. Merge the two instead of renaming one into the other.`,
    );
    this.name = "SupplierNameTakenError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

export async function getSuppliers(db: Database, params: { teamId: string }) {
  const linked = db
    .select({
      supplierId: transactions.supplierId,
      transactionCount: count().as("transaction_count"),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        isNotNull(transactions.supplierId),
      ),
    )
    .groupBy(transactions.supplierId)
    .as("linked");

  const ruled = db
    .select({
      supplierId: supplierRules.supplierId,
      ruleCount: count().as("rule_count"),
    })
    .from(supplierRules)
    .where(eq(supplierRules.teamId, params.teamId))
    .groupBy(supplierRules.supplierId)
    .as("ruled");

  return db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      vatNumber: suppliers.vatNumber,
      source: suppliers.source,
      externalId: suppliers.externalId,
      canHaveSupplierInvoice: suppliers.canHaveSupplierInvoice,
      createdAt: suppliers.createdAt,
      defaultCategory: {
        id: transactionCategories.id,
        name: transactionCategories.name,
        slug: transactionCategories.slug,
        color: transactionCategories.color,
      },
      transactionCount:
        sql<number>`coalesce(${linked.transactionCount}, 0)`.mapWith(Number),
      ruleCount: sql<number>`coalesce(${ruled.ruleCount}, 0)`.mapWith(Number),
    })
    .from(suppliers)
    .leftJoin(
      transactionCategories,
      eq(transactionCategories.id, suppliers.defaultCategoryId),
    )
    .leftJoin(linked, eq(linked.supplierId, suppliers.id))
    .leftJoin(ruled, eq(ruled.supplierId, suppliers.id))
    .where(eq(suppliers.teamId, params.teamId))
    .orderBy(sql`lower(${suppliers.name})`);
}

export async function getSupplierById(
  db: Database,
  params: { teamId: string; id: string },
) {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(
      and(eq(suppliers.id, params.id), eq(suppliers.teamId, params.teamId)),
    )
    .limit(1);

  return supplier ?? null;
}

export type CreateSupplierParams = {
  teamId: string;
  name: string;
  vatNumber?: string | null;
  defaultCategoryId?: string | null;
  canHaveSupplierInvoice?: boolean | null;
  source?: SupplierSource;
};

/** Create a supplier. Throws `SupplierNameTakenError` if the name is in use. */
export async function createSupplier(
  db: DatabaseOrTransaction,
  params: CreateSupplierParams,
) {
  const name = normaliseSupplierName(params.name);

  if (!name) {
    throw new Error("A supplier needs a name");
  }

  if (params.defaultCategoryId) {
    await assertCategoryOnTeam(db, params.teamId, params.defaultCategoryId);
  }

  try {
    const [supplier] = await db
      .insert(suppliers)
      .values({
        teamId: params.teamId,
        name,
        vatNumber: params.vatNumber ?? null,
        defaultCategoryId: params.defaultCategoryId ?? null,
        canHaveSupplierInvoice: params.canHaveSupplierInvoice ?? null,
        source: params.source ?? "manual",
      })
      .returning();

    return supplier!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new SupplierNameTakenError(name);
    throw error;
  }
}

/**
 * The supplier with this name, created if there is none. Case-insensitive, so
 * `Cursor Inc` and `CURSOR INC` are one supplier.
 *
 * Race-safe: two enrichment runs naming the same new supplier at once both
 * land on one row, because the name is unique per team and the loser of the
 * insert reads the winner's.
 */
export async function findOrCreateSupplier(
  db: DatabaseOrTransaction,
  params: { teamId: string; name: string; source: SupplierSource },
) {
  const name = normaliseSupplierName(params.name);

  const findExisting = async () => {
    const [existing] = await db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.teamId, params.teamId),
          sql`lower(${suppliers.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    return existing ?? null;
  };

  const existing = await findExisting();
  if (existing) return { supplier: existing, created: false };

  const [inserted] = await db
    .insert(suppliers)
    .values({ teamId: params.teamId, name, source: params.source })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { supplier: inserted, created: true };

  const raced = await findExisting();
  if (!raced) {
    throw new Error(`Could not create or find supplier "${name}"`);
  }
  return { supplier: raced, created: false };
}

export type UpdateSupplierParams = {
  teamId: string;
  id: string;
  name?: string;
  vatNumber?: string | null;
  defaultCategoryId?: string | null;
  canHaveSupplierInvoice?: boolean | null;
};

export async function updateSupplier(
  db: Database,
  params: UpdateSupplierParams,
) {
  const { teamId, id, ...updates } = params;

  if (updates.name !== undefined) {
    updates.name = normaliseSupplierName(updates.name);
    if (!updates.name) throw new Error("A supplier needs a name");
  }

  if (updates.defaultCategoryId) {
    await assertCategoryOnTeam(db, teamId, updates.defaultCategoryId);
  }

  try {
    const [supplier] = await db
      .update(suppliers)
      .set(updates)
      .where(and(eq(suppliers.id, id), eq(suppliers.teamId, teamId)))
      .returning();

    return supplier ?? null;
  } catch (error) {
    if (isUniqueViolation(error) && updates.name) {
      throw new SupplierNameTakenError(updates.name);
    }
    throw error;
  }
}

/**
 * Delete a supplier. Its rules go with it, and every payment that pointed at it
 * is handed back to recognition — a person's link included, because what that
 * person chose no longer exists. Payments another rule matches are re-linked
 * straight away.
 */
export async function deleteSupplier(
  db: Database,
  params: { teamId: string; id: string },
) {
  const deleted = await db.transaction(async (tx) => {
    const released = await tx
      .update(transactions)
      .set({ supplierId: null, supplierRuleId: null, supplierLink: null })
      .where(
        and(
          eq(transactions.teamId, params.teamId),
          eq(transactions.supplierId, params.id),
        ),
      )
      .returning({ id: transactions.id });

    const [supplier] = await tx
      .delete(suppliers)
      .where(
        and(eq(suppliers.id, params.id), eq(suppliers.teamId, params.teamId)),
      )
      .returning();

    return supplier
      ? { supplier, released: released.map((row) => row.id) }
      : null;
  });

  if (!deleted) return null;

  await applySupplierRules(db, {
    teamId: params.teamId,
    transactionIds: deleted.released,
  });

  return deleted.supplier;
}

export class SupplierMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierMergeError";
  }
}

/**
 * Fold one supplier into another: two rows that turn out to be one company.
 *
 * The model will produce `Xerius` and `Xerius Sociaal Verzekeringsfonds VZW`
 * before anyone notices, so this is needed from the first day. Everything the
 * merged supplier had moves to the one kept — its payments with their link
 * unchanged, so a person's choice stays a person's choice, and its rules, so
 * every spelling that recognised the old row now recognises the kept one. The
 * kept supplier's own fields win; the merged one only fills what is empty.
 *
 * Refused when both carry a different accounting-system id: that is two
 * contacts in the books, and merging them here would quietly make one of the
 * two ids unreachable.
 */
export async function mergeSuppliers(
  db: Database,
  params: { teamId: string; sourceId: string; targetId: string },
) {
  if (params.sourceId === params.targetId) {
    throw new SupplierMergeError("A supplier cannot be merged into itself");
  }

  return db.transaction(async (tx) => {
    const both = await tx
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.teamId, params.teamId),
          inArray(suppliers.id, [params.sourceId, params.targetId]),
        ),
      )
      .for("update");

    const source = both.find((row) => row.id === params.sourceId);
    const target = both.find((row) => row.id === params.targetId);

    if (!source || !target) {
      throw new SupplierMergeError("Both suppliers must exist on this team");
    }

    if (
      source.externalId &&
      target.externalId &&
      source.externalId !== target.externalId
    ) {
      throw new SupplierMergeError(
        "Both suppliers are linked to a different contact in the books, so they are two contacts there. Unlink one first.",
      );
    }

    const moved = await tx
      .update(transactions)
      .set({ supplierId: target.id })
      .where(
        and(
          eq(transactions.teamId, params.teamId),
          eq(transactions.supplierId, source.id),
        ),
      )
      .returning({ id: transactions.id });

    await tx
      .update(supplierRules)
      .set({ supplierId: target.id })
      .where(
        and(
          eq(supplierRules.teamId, params.teamId),
          eq(supplierRules.supplierId, source.id),
        ),
      );

    // The source's name goes; every rule that recognised it came along, so
    // nothing that found it before stops finding the kept one.
    await tx.delete(suppliers).where(eq(suppliers.id, source.id));

    const [merged] = await tx
      .update(suppliers)
      .set({
        vatNumber: target.vatNumber ?? source.vatNumber,
        defaultCategoryId: target.defaultCategoryId ?? source.defaultCategoryId,
        canHaveSupplierInvoice:
          target.canHaveSupplierInvoice ?? source.canHaveSupplierInvoice,
        externalId: target.externalId ?? source.externalId,
        // A person having kept this row is a person's decision about it.
        source:
          target.source === "manual" || source.source === "manual"
            ? "manual"
            : target.source,
      })
      .where(eq(suppliers.id, target.id))
      .returning();

    return { supplier: merged!, movedTransactions: moved.length };
  });
}

async function assertCategoryOnTeam(
  db: DatabaseOrTransaction,
  teamId: string,
  categoryId: string,
) {
  const [category] = await db
    .select({ id: transactionCategories.id })
    .from(transactionCategories)
    .where(
      and(
        eq(transactionCategories.id, categoryId),
        eq(transactionCategories.teamId, teamId),
      ),
    )
    .limit(1);

  if (!category) {
    throw new Error("That category does not belong to this team");
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function getSupplierRules(
  db: DatabaseOrTransaction,
  params: { teamId: string; supplierId?: string | null },
) {
  return db
    .select({
      id: supplierRules.id,
      supplierId: supplierRules.supplierId,
      field: supplierRules.field,
      value: supplierRules.value,
      source: supplierRules.source,
      createdAt: supplierRules.createdAt,
      matchedCount: sql<number>`(
        SELECT count(*) FROM ${transactions}
        WHERE ${transactions.supplierRuleId} = ${supplierRules.id}
      )`.mapWith(Number),
    })
    .from(supplierRules)
    .where(
      and(
        eq(supplierRules.teamId, params.teamId),
        params.supplierId === undefined
          ? undefined
          : params.supplierId === null
            ? isNull(supplierRules.supplierId)
            : eq(supplierRules.supplierId, params.supplierId),
      ),
    )
    .orderBy(
      asc(supplierRules.field),
      desc(sql`length(${supplierRules.value})`),
    );
}

export type SupplierRuleInput = {
  teamId: string;
  /** Null for a rule saying this text names nobody. */
  supplierId: string | null;
  field: SupplierRuleField;
  /** As typed; stored normalised. */
  value: string;
  source?: SupplierSource;
};

function ruleValueOrThrow(field: SupplierRuleField, value: string): string {
  const normalised = normaliseRuleValue(field, value);
  if (!normalised) throw new Error("A rule needs something to match");
  return normalised;
}

/**
 * Store a rule without applying it. There is one rule per text per team, so
 * saving a text that already has a rule re-points that rule rather than adding
 * a second one to disagree with it.
 *
 * Callers that want history to follow call `applySupplierRules` after; the
 * enrichment job saves several rules and applies once.
 */
export async function upsertSupplierRule(
  db: DatabaseOrTransaction,
  params: SupplierRuleInput,
) {
  const value = ruleValueOrThrow(params.field, params.value);

  if (params.supplierId) {
    await assertSupplierOnTeam(db, params.teamId, params.supplierId);
  }

  const [rule] = await db
    .insert(supplierRules)
    .values({
      teamId: params.teamId,
      supplierId: params.supplierId,
      field: params.field,
      value,
      source: params.source ?? "manual",
    })
    .onConflictDoUpdate({
      target: [supplierRules.teamId, supplierRules.field, supplierRules.value],
      set: {
        supplierId: params.supplierId,
        source: params.source ?? "manual",
      },
    })
    .returning();

  return rule!;
}

/**
 * Store a rule only if the text has none yet. What the model proposes never
 * replaces a rule that already exists, whoever made it.
 */
export async function insertSupplierRuleIfAbsent(
  db: DatabaseOrTransaction,
  params: SupplierRuleInput,
) {
  const value = ruleValueOrThrow(params.field, params.value);

  const [inserted] = await db
    .insert(supplierRules)
    .values({
      teamId: params.teamId,
      supplierId: params.supplierId,
      field: params.field,
      value,
      source: params.source ?? "manual",
    })
    .onConflictDoNothing()
    .returning();

  return inserted ?? null;
}

/** Save a rule and apply it to every payment a person has not decided. */
export async function saveSupplierRule(
  db: Database,
  params: SupplierRuleInput,
) {
  const rule = await upsertSupplierRule(db, params);
  const applied = await applySupplierRules(db, { teamId: params.teamId });
  return { rule, applied };
}

/**
 * Delete a rule. The payments it linked are recognised again: another rule may
 * take them, and otherwise they are left with no supplier, visibly.
 */
export async function deleteSupplierRule(
  db: Database,
  params: { teamId: string; id: string },
) {
  const [rule] = await db
    .delete(supplierRules)
    .where(
      and(
        eq(supplierRules.id, params.id),
        eq(supplierRules.teamId, params.teamId),
      ),
    )
    .returning();

  if (!rule) return null;

  // The foreign key has already cleared `supplier_rule_id` on the rows it
  // linked, so they are found by what is left: a rule link with no rule.
  const orphaned = await db
    .update(transactions)
    .set({ supplierId: null, supplierLink: null })
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        eq(transactions.supplierLink, "rule"),
        isNull(transactions.supplierRuleId),
      ),
    )
    .returning({ id: transactions.id });

  const applied = await applySupplierRules(db, {
    teamId: params.teamId,
    transactionIds: orphaned.map((row) => row.id),
  });

  return { rule, applied };
}

async function assertSupplierOnTeam(
  db: DatabaseOrTransaction,
  teamId: string,
  supplierId: string,
) {
  const [supplier] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.teamId, teamId)))
    .limit(1);

  if (!supplier) {
    throw new Error("That supplier does not belong to this team");
  }
}

// ---------------------------------------------------------------------------
// Applying rules
// ---------------------------------------------------------------------------

type Candidate = LinkState & {
  id: string;
  name: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
};

const candidateColumns = {
  id: transactions.id,
  name: transactions.name,
  counterpartyName: transactions.counterpartyName,
  counterpartyIban: transactions.counterpartyIban,
  supplierId: transactions.supplierId,
  supplierRuleId: transactions.supplierRuleId,
  supplierLink: transactions.supplierLink,
};

/** Every payment automation may still link: anything a person has not decided. */
function undecidedSql(teamId: string) {
  return and(
    eq(transactions.teamId, teamId),
    or(
      isNull(transactions.supplierLink),
      ne(transactions.supplierLink, "person"),
    ),
  );
}

async function loadRules(
  db: DatabaseOrTransaction,
  teamId: string,
): Promise<SupplierRuleForMatching[]> {
  return db
    .select({
      id: supplierRules.id,
      supplierId: supplierRules.supplierId,
      field: supplierRules.field,
      value: supplierRules.value,
    })
    .from(supplierRules)
    .where(eq(supplierRules.teamId, teamId));
}

/**
 * What the rules make of a payment that automation may relink. A rule outranks
 * a guess the model made on its own; where no rule answers, a guess stands and
 * a stale rule link is dropped.
 */
function nextLink(
  rules: SupplierRuleForMatching[],
  candidate: Candidate,
): LinkState {
  const match = resolveSupplier(rules, candidate);

  if (match) {
    return {
      supplierId: match.supplierId,
      supplierRuleId: match.ruleId,
      supplierLink: "rule",
    };
  }

  if (candidate.supplierLink === "ai") {
    return {
      supplierId: candidate.supplierId,
      supplierRuleId: null,
      supplierLink: "ai",
    };
  }

  return { supplierId: null, supplierRuleId: null, supplierLink: null };
}

function sameLink(a: LinkState, b: LinkState): boolean {
  return (
    a.supplierId === b.supplierId &&
    a.supplierRuleId === b.supplierRuleId &&
    a.supplierLink === b.supplierLink
  );
}

export type AppliedSupplierRules = {
  /** Had no supplier, now has one. */
  linked: number;
  /** Moved from one supplier, or one rule, to another. */
  moved: number;
  /** Lost a rule link that no rule gives any more. */
  unlinked: number;
};

/**
 * Bring every undecided payment in line with the rules. Deterministic: the
 * same rules and the same text always give the same links, which is what makes
 * "matched by rule X" true.
 *
 * `transactionIds` narrows it to those payments; without it the whole team is
 * re-read. That is a few thousand rows here and one query each way, and it is
 * what a rule edit needs, because a rule can reach any payment in history.
 */
export async function applySupplierRules(
  db: DatabaseOrTransaction,
  params: { teamId: string; transactionIds?: string[] },
): Promise<AppliedSupplierRules> {
  const result: AppliedSupplierRules = { linked: 0, moved: 0, unlinked: 0 };

  if (params.transactionIds && params.transactionIds.length === 0) {
    return result;
  }

  const rules = await loadRules(db, params.teamId);

  const candidates = await db
    .select(candidateColumns)
    .from(transactions)
    .where(
      and(
        undecidedSql(params.teamId),
        params.transactionIds
          ? inArray(transactions.id, params.transactionIds)
          : undefined,
      ),
    );

  // One update per distinct outcome rather than one per row.
  const byOutcome = new Map<string, { link: LinkState; ids: string[] }>();

  for (const candidate of candidates) {
    const next = nextLink(rules, candidate);
    if (sameLink(candidate, next)) continue;

    if (!candidate.supplierId && next.supplierId) result.linked++;
    else if (candidate.supplierId && !next.supplierId) result.unlinked++;
    else result.moved++;

    const key = `${next.supplierId}|${next.supplierRuleId}|${next.supplierLink}`;
    const outcome = byOutcome.get(key) ?? { link: next, ids: [] };
    outcome.ids.push(candidate.id);
    byOutcome.set(key, outcome);
  }

  for (const { link, ids } of byOutcome.values()) {
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(transactions)
        .set(link)
        .where(
          and(
            undecidedSql(params.teamId),
            inArray(transactions.id, ids.slice(i, i + 500)),
          ),
        );
    }
  }

  return result;
}

export type SupplierRulePreviewRow = {
  id: string;
  date: string;
  name: string;
  amount: number;
  currency: string;
  /** Who it points at today, if anyone. */
  currentSupplier: { id: string; name: string } | null;
  currentLink: LinkState["supplierLink"];
  /**
   * - `link`: has no supplier today and would get this one.
   * - `move`: points at another supplier today and would be taken from it.
   * - `unchanged`: already this supplier's.
   * - `kept`: matches, but a person decided it, so it stays where it is.
   * - `outranked`: matches, but a more specific rule answers first.
   * - `unlink`: would lose its supplier — a rule saying this text names nobody.
   */
  effect: "link" | "move" | "unchanged" | "kept" | "outranked" | "unlink";
};

/**
 * What a rule would take, before it is saved — including payments another
 * supplier has today, so a collision is visible before it happens (FF-1555's
 * most valuable piece of the editing surface).
 *
 * Every payment the rule's text matches is listed, whether or not the rule
 * would win it, so a person can see why one is not moving.
 */
export async function previewSupplierRule(
  db: Database,
  params: SupplierRuleInput & { limit?: number },
): Promise<{ rows: SupplierRulePreviewRow[]; total: number }> {
  const value = ruleValueOrThrow(params.field, params.value);
  const draftId = "draft";

  const existing = await loadRules(db, params.teamId);
  const rules: SupplierRuleForMatching[] = [
    // The saved rule for this same text is what the draft replaces.
    ...existing.filter(
      (rule) => !(rule.field === params.field && rule.value === value),
    ),
    { id: draftId, supplierId: params.supplierId, field: params.field, value },
  ];

  // The whole team, resolved here rather than narrowed in SQL: the match is
  // on normalised text, and a second implementation of the normalising in SQL
  // is a second answer to disagree with the first. A few thousand rows.
  const rows = await db
    .select({
      ...candidateColumns,
      date: transactions.date,
      amount: transactions.amount,
      currency: transactions.currency,
      currentSupplierName: suppliers.name,
    })
    .from(transactions)
    .leftJoin(suppliers, eq(suppliers.id, transactions.supplierId))
    .where(eq(transactions.teamId, params.teamId))
    .orderBy(desc(transactions.date), transactions.id);

  const preview: SupplierRulePreviewRow[] = rows
    .filter((row) => ruleMatches({ field: params.field, value }, row))
    .map((row) => ({
      id: row.id,
      date: row.date,
      name: row.name,
      amount: row.amount,
      currency: row.currency,
      currentSupplier:
        row.supplierId && row.currentSupplierName
          ? { id: row.supplierId, name: row.currentSupplierName }
          : null,
      currentLink: row.supplierLink,
      effect: previewEffect(rules, row, params.supplierId, draftId),
    }));

  return { rows: preview.slice(0, params.limit ?? 200), total: preview.length };
}

function previewEffect(
  rules: SupplierRuleForMatching[],
  row: Candidate,
  supplierId: string | null,
  draftId: string,
): SupplierRulePreviewRow["effect"] {
  if (row.supplierLink === "person") {
    return row.supplierId === supplierId ? "unchanged" : "kept";
  }

  const next = nextLink(rules, row);

  if (next.supplierId === row.supplierId) {
    return next.supplierRuleId === draftId || row.supplierId === supplierId
      ? "unchanged"
      : "outranked";
  }

  if (!next.supplierId) return "unlink";
  if (!row.supplierId) return "link";
  return "move";
}

// ---------------------------------------------------------------------------
// The link on one transaction
// ---------------------------------------------------------------------------

/**
 * A person's answer for one payment: this supplier, or none. It is final —
 * no rule and no enrichment run moves it again, which is what makes a
 * correction survive.
 */
export async function setTransactionSupplier(
  db: Database,
  params: { teamId: string; transactionId: string; supplierId: string | null },
) {
  if (params.supplierId) {
    await assertSupplierOnTeam(db, params.teamId, params.supplierId);
  }

  const [row] = await db
    .update(transactions)
    .set({
      supplierId: params.supplierId,
      supplierRuleId: null,
      supplierLink: "person",
    })
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.teamId, params.teamId),
      ),
    )
    .returning({ id: transactions.id });

  return row ?? null;
}

/** Give a payment back to automation: the rules decide it again from scratch. */
export async function resetTransactionSupplier(
  db: Database,
  params: { teamId: string; transactionId: string },
) {
  const [row] = await db
    .update(transactions)
    .set({ supplierId: null, supplierRuleId: null, supplierLink: null })
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.teamId, params.teamId),
      ),
    )
    .returning({ id: transactions.id });

  if (!row) return null;

  await applySupplierRules(db, {
    teamId: params.teamId,
    transactionIds: [row.id],
  });

  return row;
}

/**
 * Link payments to a supplier the model named when its answer could not be
 * kept as a rule. Only touches payments nothing has linked yet.
 */
export async function linkTransactionsByGuess(
  db: DatabaseOrTransaction,
  params: { teamId: string; supplierId: string; transactionIds: string[] },
) {
  if (params.transactionIds.length === 0) return 0;

  const rows = await db
    .update(transactions)
    .set({
      supplierId: params.supplierId,
      supplierRuleId: null,
      supplierLink: "ai",
    })
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        inArray(transactions.id, params.transactionIds),
        isNull(transactions.supplierLink),
      ),
    )
    .returning({ id: transactions.id });

  return rows.length;
}

// ---------------------------------------------------------------------------
// What a supplier's payments usually are
// ---------------------------------------------------------------------------

/**
 * The category each of these suppliers' payments should get without asking a
 * model — the memory FF-1554's `getCategoriesByCounterparty` stood in for,
 * keyed on identity instead of spelling.
 *
 * The supplier's own default wins: a person set it. Where there is none, the
 * category the supplier's expenses have **consistently** had — one category
 * across all of them. A supplier with two is one this team has not made its
 * mind up about, and gets no answer rather than a majority vote, because the
 * majority is wrong on the live books (Xerius: `contractors` twice,
 * `employer-taxes` once).
 */
export async function getCategoriesBySupplier(
  db: DatabaseOrTransaction,
  params: { teamId: string; supplierIds: string[] },
): Promise<Map<string, string>> {
  const wanted = [...new Set(params.supplierIds)];
  const answers = new Map<string, string>();

  if (wanted.length === 0) return answers;

  const defaults = await db
    .select({ supplierId: suppliers.id, slug: transactionCategories.slug })
    .from(suppliers)
    .innerJoin(
      transactionCategories,
      eq(transactionCategories.id, suppliers.defaultCategoryId),
    )
    .where(
      and(eq(suppliers.teamId, params.teamId), inArray(suppliers.id, wanted)),
    );

  for (const row of defaults) {
    if (row.slug) answers.set(row.supplierId, row.slug);
  }

  const remaining = wanted.filter((id) => !answers.has(id));
  if (remaining.length === 0) return answers;

  const history = await db
    .select({
      supplierId: transactions.supplierId,
      categorySlug: transactions.categorySlug,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.teamId, params.teamId),
        inArray(transactions.supplierId, remaining),
        isNotNull(transactions.categorySlug),
        ne(transactions.categorySlug, UNCATEGORIZED),
        lte(transactions.amount, 0),
      ),
    )
    .groupBy(transactions.supplierId, transactions.categorySlug);

  const seen = new Map<string, string | null>();

  for (const row of history) {
    if (!row.supplierId || !row.categorySlug) continue;
    const before = seen.get(row.supplierId);
    seen.set(
      row.supplierId,
      before === undefined || before === row.categorySlug
        ? row.categorySlug
        : null,
    );
  }

  for (const [supplierId, slug] of seen) {
    if (slug) answers.set(supplierId, slug);
  }

  return answers;
}
