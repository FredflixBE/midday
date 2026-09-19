/**
 * Seam under test: the team's work types and a customer's own rates for them
 * (FF-1607).
 *
 * What the ticket is done by: the list can be kept (added to, renamed,
 * reordered, archived), a customer can have a different rate, and an archived
 * type leaves the pickers while still resolving for the quotes that use it.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml; see
 * suppliers.test.ts for how to run it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../client";
import {
  archiveWorkType,
  createWorkType,
  getCustomerWorkTypeRates,
  getWorkTypes,
  reorderWorkTypes,
  restoreWorkType,
  setCustomerWorkTypeRate,
  updateWorkType,
  WorkTypeInputError,
} from "../queries/work-types";
import { customers } from "../schema";
import { seedAll, TEAM_EUR_ID, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

describe.skipIf(SKIP)("work types", () => {
  let db: Database;

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function customer(teamId = TEAM_USD_ID) {
    const [row] = await db
      .insert(customers)
      .values({ teamId, name: "Customer", email: "customer@example.com" })
      .returning({ id: customers.id });
    return row!.id;
  }

  function create(name: string, hourlyRate = 100, teamId = TEAM_USD_ID) {
    return createWorkType(db, { teamId, name, hourlyRate });
  }

  test("a new type goes to the end of the list, in the team's currency", async () => {
    await create("Maintenance", 95);
    const development = await create("Development", 110.5);

    expect(development).toMatchObject({
      name: "Development",
      hourlyRate: 110.5,
      currency: "USD",
      archivedAt: null,
    });

    const list = await getWorkTypes(db, { teamId: TEAM_USD_ID });
    expect(list.map((w) => w.name)).toEqual(["Maintenance", "Development"]);
  });

  test("a name is trimmed and cannot be empty", async () => {
    expect((await create("  Follow-up  ")).name).toBe("Follow-up");
    await expect(create("   ")).rejects.toBeInstanceOf(WorkTypeInputError);
  });

  test("a rate cannot be negative", async () => {
    await expect(create("Development", -1)).rejects.toBeInstanceOf(
      WorkTypeInputError,
    );
  });

  test("renaming and repricing touch only that type", async () => {
    const a = await create("Maintenance", 95);
    const b = await create("Development", 110);

    const updated = await updateWorkType(db, {
      id: a.id,
      teamId: TEAM_USD_ID,
      name: "First-line maintenance",
      hourlyRate: 90,
    });

    expect(updated).toMatchObject({
      name: "First-line maintenance",
      hourlyRate: 90,
    });
    const list = await getWorkTypes(db, { teamId: TEAM_USD_ID });
    expect(list.find((w) => w.id === b.id)).toMatchObject({
      name: "Development",
      hourlyRate: 110,
    });
  });

  test("another team's type is not found, not changed", async () => {
    const theirs = await create("Development", 110, TEAM_EUR_ID);

    expect(
      await updateWorkType(db, {
        id: theirs.id,
        teamId: TEAM_USD_ID,
        name: "Taken",
      }),
    ).toBeNull();
    expect(
      await archiveWorkType(db, { id: theirs.id, teamId: TEAM_USD_ID }),
    ).toBeNull();
    const [still] = await getWorkTypes(db, { teamId: TEAM_EUR_ID });
    expect(still).toMatchObject({ name: "Development", archivedAt: null });
  });

  test("reordering sets the order the list comes back in", async () => {
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");

    await reorderWorkTypes(db, {
      teamId: TEAM_USD_ID,
      ids: [c.id, a.id, b.id],
    });

    const list = await getWorkTypes(db, { teamId: TEAM_USD_ID });
    expect(list.map((w) => w.name)).toEqual(["C", "A", "B"]);
  });

  test("a reorder naming another team's type changes nothing", async () => {
    const a = await create("A");
    const b = await create("B");
    const theirs = await create("Theirs", 100, TEAM_EUR_ID);

    await expect(
      reorderWorkTypes(db, {
        teamId: TEAM_USD_ID,
        ids: [b.id, theirs.id, a.id],
      }),
    ).rejects.toBeInstanceOf(WorkTypeInputError);

    const list = await getWorkTypes(db, { teamId: TEAM_USD_ID });
    expect(list.map((w) => w.name)).toEqual(["A", "B"]);
  });

  test("an archived type leaves the list but still resolves by id", async () => {
    const a = await create("Maintenance");
    const b = await create("Development");

    await archiveWorkType(db, { id: a.id, teamId: TEAM_USD_ID });

    const pickable = await getWorkTypes(db, { teamId: TEAM_USD_ID });
    expect(pickable.map((w) => w.id)).toEqual([b.id]);

    const all = await getWorkTypes(db, {
      teamId: TEAM_USD_ID,
      includeArchived: true,
    });
    expect(all.find((w) => w.id === a.id)?.archivedAt).not.toBeNull();
  });

  test("restoring puts an archived type back in the list", async () => {
    const a = await create("Maintenance");
    await archiveWorkType(db, { id: a.id, teamId: TEAM_USD_ID });

    await restoreWorkType(db, { id: a.id, teamId: TEAM_USD_ID });

    const list = await getWorkTypes(db, { teamId: TEAM_USD_ID });
    expect(list.map((w) => w.id)).toEqual([a.id]);
  });

  describe("a customer's own rates", () => {
    test("a customer can have its own rate, and clearing it brings back the default", async () => {
      const wt = await create("Development", 110);
      const c = await customer();

      await setCustomerWorkTypeRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        workTypeId: wt.id,
        hourlyRate: 95,
      });
      expect(
        await getCustomerWorkTypeRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([{ workTypeId: wt.id, hourlyRate: 95 }]);

      await setCustomerWorkTypeRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        workTypeId: wt.id,
        hourlyRate: 100,
      });
      expect(
        await getCustomerWorkTypeRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([{ workTypeId: wt.id, hourlyRate: 100 }]);

      await setCustomerWorkTypeRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        workTypeId: wt.id,
        hourlyRate: null,
      });
      expect(
        await getCustomerWorkTypeRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([]);
    });

    test("one customer's rate is not another's", async () => {
      const wt = await create("Development", 110);
      const c1 = await customer();
      const c2 = await customer();

      await setCustomerWorkTypeRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c1,
        workTypeId: wt.id,
        hourlyRate: 95,
      });

      expect(
        await getCustomerWorkTypeRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c2,
        }),
      ).toEqual([]);
    });

    test("a rate for another team's customer or type is not found", async () => {
      const ours = await create("Development", 110);
      const theirs = await create("Development", 110, TEAM_EUR_ID);
      const ourCustomer = await customer();
      const theirCustomer = await customer(TEAM_EUR_ID);

      expect(
        await setCustomerWorkTypeRate(db, {
          teamId: TEAM_USD_ID,
          customerId: theirCustomer,
          workTypeId: ours.id,
          hourlyRate: 1,
        }),
      ).toBeNull();
      expect(
        await setCustomerWorkTypeRate(db, {
          teamId: TEAM_USD_ID,
          customerId: ourCustomer,
          workTypeId: theirs.id,
          hourlyRate: 1,
        }),
      ).toBeNull();
      expect(
        await getCustomerWorkTypeRates(db, {
          teamId: TEAM_EUR_ID,
          customerId: theirCustomer,
        }),
      ).toEqual([]);
    });

    test("an archived type's customer rate still resolves", async () => {
      const wt = await create("Development", 110);
      const c = await customer();
      await setCustomerWorkTypeRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        workTypeId: wt.id,
        hourlyRate: 95,
      });

      await archiveWorkType(db, { id: wt.id, teamId: TEAM_USD_ID });

      expect(
        await getCustomerWorkTypeRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([{ workTypeId: wt.id, hourlyRate: 95 }]);
    });
  });
});
