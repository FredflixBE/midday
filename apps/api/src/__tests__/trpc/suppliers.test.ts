/**
 * The supplier router's own behaviour (FF-1555): every call is scoped to the
 * caller's team, a person's mistake comes back as one rather than a 500, and a
 * rule a person saves is recorded as theirs. What the queries do is tested
 * against a database in packages/db.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSupplier,
  mergeSuppliers,
  SupplierInputError,
  SupplierMergeError,
  SupplierNameTakenError,
  saveSupplierRule,
  setTransactionSupplier,
} from "@midday/db/queries";
import { createCallerFactory } from "../../trpc/init";
import { suppliersRouter } from "../../trpc/routers/suppliers";
import { createTestContext } from "../helpers/test-context";
import { asMock } from "../setup";

const createCaller = createCallerFactory(suppliersRouter);

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "a1b2c3d4-0000-4000-8000-000000000002";

describe("tRPC: suppliers", () => {
  beforeEach(() => {
    for (const fn of [
      createSupplier,
      mergeSuppliers,
      saveSupplierRule,
      setTransactionSupplier,
    ]) {
      asMock(fn).mockReset();
      asMock(fn).mockImplementation(() => Promise.resolve({}));
    }
  });

  test("a name already in use is a conflict the person can act on", async () => {
    asMock(createSupplier).mockImplementation(() =>
      Promise.reject(new SupplierNameTakenError("Cursor Inc")),
    );

    const caller = createCaller(createTestContext());

    await expect(caller.create({ name: "Cursor Inc" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  test("a refused merge says why, as a bad request", async () => {
    asMock(mergeSuppliers).mockImplementation(() =>
      Promise.reject(new SupplierMergeError("two contacts in the books")),
    );

    const caller = createCaller(createTestContext());

    await expect(
      caller.merge({ sourceId: A, targetId: B }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "two contacts in the books",
    });
  });

  test("a payment that is not this team's is not found, not quietly skipped", async () => {
    asMock(setTransactionSupplier).mockImplementation(() =>
      Promise.resolve(null),
    );

    const caller = createCaller(createTestContext());

    await expect(
      caller.setForTransaction({ transactionId: A, supplierId: B }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("another team's supplier is a bad request, not a server error", async () => {
    asMock(setTransactionSupplier).mockImplementation(() =>
      Promise.reject(
        new SupplierInputError("That supplier does not belong to this team"),
      ),
    );

    const caller = createCaller(createTestContext());

    await expect(
      caller.setForTransaction({ transactionId: A, supplierId: B }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("a rule a person saves is theirs, and scoped to their team", async () => {
    const caller = createCaller(createTestContext());

    await caller.saveRule({ supplierId: A, field: "name", value: "Xerius" });

    expect(asMock(saveSupplierRule).mock.calls[0]?.[1]).toEqual({
      supplierId: A,
      field: "name",
      value: "Xerius",
      teamId: "test-team-id",
      source: "manual",
    });
  });

  test("'no supplier' can be said about a payment", async () => {
    const caller = createCaller(createTestContext());

    await caller.setForTransaction({ transactionId: A, supplierId: null });

    expect(asMock(setTransactionSupplier).mock.calls[0]?.[1]).toEqual({
      transactionId: A,
      supplierId: null,
      teamId: "test-team-id",
    });
  });
});
