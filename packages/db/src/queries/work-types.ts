import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Database } from "../client";
import { customers, customerWorkTypeRates, teams, workTypes } from "../schema";

/**
 * Work types and their rates (FF-1607). Every price on a quote is hours × a
 * rate, and the rate depends on the type of work: the type's default, unless
 * the customer has its own (and a quote can override both, in its content).
 *
 * A type is never deleted. Quotes keep its id, so archiving only takes it out
 * of the list a person picks from; `includeArchived` is how a quote still
 * finds it.
 */

/** A person's mistake, told apart from a failure so the API can say so. */
export class WorkTypeInputError extends Error {}

export type WorkType = typeof workTypes.$inferSelect;

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new WorkTypeInputError("A work type needs a name");
  return trimmed;
}

function checkRate(rate: number) {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new WorkTypeInputError("A rate cannot be negative");
  }
  return rate;
}

export async function getWorkTypes(
  db: Database,
  params: { teamId: string; includeArchived?: boolean },
): Promise<WorkType[]> {
  return db
    .select()
    .from(workTypes)
    .where(
      and(
        eq(workTypes.teamId, params.teamId),
        params.includeArchived ? undefined : isNull(workTypes.archivedAt),
      ),
    )
    .orderBy(asc(workTypes.position), asc(workTypes.createdAt));
}

/** Added at the end of the list, in the team's base currency. */
export async function createWorkType(
  db: Database,
  params: { teamId: string; name: string; hourlyRate: number },
): Promise<WorkType> {
  const name = cleanName(params.name);
  const hourlyRate = checkRate(params.hourlyRate);

  const [team] = await db
    .select({ baseCurrency: teams.baseCurrency })
    .from(teams)
    .where(eq(teams.id, params.teamId));
  const [last] = await db
    .select({ position: max(workTypes.position) })
    .from(workTypes)
    .where(eq(workTypes.teamId, params.teamId));

  const [row] = await db
    .insert(workTypes)
    .values({
      teamId: params.teamId,
      name,
      hourlyRate,
      currency: team?.baseCurrency ?? "EUR",
      position: last?.position == null ? 0 : last.position + 1,
    })
    .returning();
  return row!;
}

/** Rename or reprice. Null when the type is not the team's. */
export async function updateWorkType(
  db: Database,
  params: { id: string; teamId: string; name?: string; hourlyRate?: number },
): Promise<WorkType | null> {
  const set: Partial<typeof workTypes.$inferInsert> = {};
  if (params.name !== undefined) set.name = cleanName(params.name);
  if (params.hourlyRate !== undefined) {
    set.hourlyRate = checkRate(params.hourlyRate);
  }
  if (Object.keys(set).length === 0) {
    throw new WorkTypeInputError("Nothing to change");
  }

  const [row] = await db
    .update(workTypes)
    .set(set)
    .where(
      and(eq(workTypes.id, params.id), eq(workTypes.teamId, params.teamId)),
    )
    .returning();
  return row ?? null;
}

/**
 * Sets the order: `ids` in the order they should appear. Every id must be the
 * team's, or nothing moves.
 */
export async function reorderWorkTypes(
  db: Database,
  params: { teamId: string; ids: string[] },
): Promise<void> {
  if (new Set(params.ids).size !== params.ids.length) {
    throw new WorkTypeInputError("A work type appears twice");
  }
  if (params.ids.length === 0) return;

  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: workTypes.id })
      .from(workTypes)
      .where(
        and(
          eq(workTypes.teamId, params.teamId),
          inArray(workTypes.id, params.ids),
        ),
      );
    if (owned.length !== params.ids.length) {
      throw new WorkTypeInputError("Unknown work type");
    }

    for (const [position, id] of params.ids.entries()) {
      await tx
        .update(workTypes)
        .set({ position })
        .where(and(eq(workTypes.id, id), eq(workTypes.teamId, params.teamId)));
    }
  });
}

async function setArchived(
  db: Database,
  params: { id: string; teamId: string },
  archived: boolean,
): Promise<WorkType | null> {
  const [row] = await db
    .update(workTypes)
    .set({ archivedAt: archived ? sql`now()` : null })
    .where(
      and(eq(workTypes.id, params.id), eq(workTypes.teamId, params.teamId)),
    )
    .returning();
  return row ?? null;
}

/** Out of the pickers; still resolves for the quotes that use it. */
export function archiveWorkType(
  db: Database,
  params: { id: string; teamId: string },
) {
  return setArchived(db, params, true);
}

export function restoreWorkType(
  db: Database,
  params: { id: string; teamId: string },
) {
  return setArchived(db, params, false);
}

/** The customer's own rates. A type without one uses its default. */
export async function getCustomerWorkTypeRates(
  db: Database,
  params: { teamId: string; customerId: string },
): Promise<{ workTypeId: string; hourlyRate: number }[]> {
  return db
    .select({
      workTypeId: customerWorkTypeRates.workTypeId,
      hourlyRate: customerWorkTypeRates.hourlyRate,
    })
    .from(customerWorkTypeRates)
    .where(
      and(
        eq(customerWorkTypeRates.teamId, params.teamId),
        eq(customerWorkTypeRates.customerId, params.customerId),
      ),
    );
}

/**
 * Sets a customer's own rate for one type, or clears it with null so the
 * default applies again. Null when the customer or the type is not the team's.
 */
export async function setCustomerWorkTypeRate(
  db: Database,
  params: {
    teamId: string;
    customerId: string;
    workTypeId: string;
    hourlyRate: number | null;
  },
): Promise<{ workTypeId: string; hourlyRate: number | null } | null> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.id, params.customerId),
        eq(customers.teamId, params.teamId),
      ),
    );
  const [workType] = await db
    .select({ id: workTypes.id })
    .from(workTypes)
    .where(
      and(
        eq(workTypes.id, params.workTypeId),
        eq(workTypes.teamId, params.teamId),
      ),
    );
  if (!customer || !workType) return null;

  const key = and(
    eq(customerWorkTypeRates.customerId, params.customerId),
    eq(customerWorkTypeRates.workTypeId, params.workTypeId),
  );

  if (params.hourlyRate === null) {
    await db.delete(customerWorkTypeRates).where(key);
    return { workTypeId: params.workTypeId, hourlyRate: null };
  }

  const hourlyRate = checkRate(params.hourlyRate);
  await db
    .insert(customerWorkTypeRates)
    .values({
      customerId: params.customerId,
      workTypeId: params.workTypeId,
      teamId: params.teamId,
      hourlyRate,
    })
    .onConflictDoUpdate({
      target: [
        customerWorkTypeRates.customerId,
        customerWorkTypeRates.workTypeId,
      ],
      set: { hourlyRate },
    });
  return { workTypeId: params.workTypeId, hourlyRate };
}
