/**
 * The work types router's own behaviour (FF-1607): every call is scoped to the
 * caller's team, a rate is checked before it reaches the database, and a
 * person's mistake comes back as one rather than a 500. What the queries do is
 * tested against a database in packages/db.
 */
import { beforeEach, describe, expect, test } from "bun:test";
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
} from "@midday/db/queries";
import { createCallerFactory } from "../../trpc/init";
import { workTypesRouter } from "../../trpc/routers/work-types";
import { createTestContext } from "../helpers/test-context";
import { asMock } from "../setup";

const createCaller = createCallerFactory(workTypesRouter);

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "a1b2c3d4-0000-4000-8000-000000000002";

describe("tRPC: workTypes", () => {
  beforeEach(() => {
    for (const fn of [
      getWorkTypes,
      createWorkType,
      updateWorkType,
      reorderWorkTypes,
      archiveWorkType,
      restoreWorkType,
      getCustomerWorkTypeRates,
      setCustomerWorkTypeRate,
    ]) {
      asMock(fn).mockReset();
      asMock(fn).mockImplementation(() => Promise.resolve({}));
    }
  });

  test("the list is the caller's team's, without archived types unless asked", async () => {
    asMock(getWorkTypes).mockImplementation(() => Promise.resolve([]));
    const caller = createCaller(createTestContext());

    await caller.list();
    await caller.list({ includeArchived: true });

    expect(asMock(getWorkTypes).mock.calls[0]?.[1]).toEqual({
      teamId: "test-team-id",
      includeArchived: undefined,
    });
    expect(asMock(getWorkTypes).mock.calls[1]?.[1]).toEqual({
      teamId: "test-team-id",
      includeArchived: true,
    });
  });

  test("a type is created on the caller's team", async () => {
    const caller = createCaller(createTestContext());

    await caller.create({ name: "Development", hourlyRate: 110 });

    expect(asMock(createWorkType).mock.calls[0]?.[1]).toEqual({
      name: "Development",
      hourlyRate: 110,
      teamId: "test-team-id",
    });
  });

  test("a negative rate or a fraction of a cent is refused before the database", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.create({ name: "Development", hourlyRate: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.update({ id: A, hourlyRate: 10.005 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(asMock(createWorkType).mock.calls).toHaveLength(0);
    expect(asMock(updateWorkType).mock.calls).toHaveLength(0);
  });

  test("another team's type is not found", async () => {
    asMock(updateWorkType).mockImplementation(() => Promise.resolve(null));
    asMock(archiveWorkType).mockImplementation(() => Promise.resolve(null));
    const caller = createCaller(createTestContext());

    await expect(caller.update({ id: A, name: "X" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(caller.archive({ id: A })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("a reorder naming a type the team does not have is a bad request", async () => {
    asMock(reorderWorkTypes).mockImplementation(() =>
      Promise.reject(new WorkTypeInputError("Unknown work type")),
    );
    const caller = createCaller(createTestContext());

    await expect(caller.reorder({ ids: [A, B] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  test("a customer's rate can be cleared, so the default applies again", async () => {
    const caller = createCaller(createTestContext());

    await caller.setCustomerRate({
      customerId: A,
      workTypeId: B,
      hourlyRate: null,
    });

    expect(asMock(setCustomerWorkTypeRate).mock.calls[0]?.[1]).toEqual({
      customerId: A,
      workTypeId: B,
      hourlyRate: null,
      teamId: "test-team-id",
    });
  });
});
