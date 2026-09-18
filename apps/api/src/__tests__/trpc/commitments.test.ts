/**
 * The commitments router's own behaviour (FF-1591): every call is scoped to
 * the caller's team, and a person's mistake comes back as one rather than a
 * 500. What the queries do is tested against a database in packages/db.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  CommitmentInputError,
  getCommitments,
  setTransactionCommitment,
  updateCommitment,
} from "@midday/db/queries";
import { createCallerFactory } from "../../trpc/init";
import { commitmentsRouter } from "../../trpc/routers/commitments";
import { createTestContext } from "../helpers/test-context";
import { asMock } from "../setup";

const createCaller = createCallerFactory(commitmentsRouter);

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "a1b2c3d4-0000-4000-8000-000000000002";

describe("tRPC: commitments", () => {
  beforeEach(() => {
    for (const fn of [
      getCommitments,
      updateCommitment,
      setTransactionCommitment,
    ]) {
      asMock(fn).mockReset();
      asMock(fn).mockImplementation(() => Promise.resolve({}));
    }
  });

  test("one supplier's commitments are read for the caller's team", async () => {
    asMock(getCommitments).mockImplementation(() => Promise.resolve([]));
    const caller = createCaller(createTestContext());

    await caller.list({ supplierId: A });

    expect(asMock(getCommitments).mock.calls[0]?.[1]).toEqual({
      teamId: "test-team-id",
      supplierId: A,
    });
  });

  test("confirming is a status change on the caller's team", async () => {
    const caller = createCaller(createTestContext());

    await caller.update({ id: A, status: "active" });

    expect(asMock(updateCommitment).mock.calls[0]?.[1]).toEqual({
      id: A,
      status: "active",
      teamId: "test-team-id",
    });
  });

  test("another team's commitment is not found, not quietly skipped", async () => {
    asMock(updateCommitment).mockImplementation(() => Promise.resolve(null));
    const caller = createCaller(createTestContext());

    await expect(
      caller.update({ id: A, status: "rejected" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a day that is not in a month is refused before it reaches the database", async () => {
    const caller = createCaller(createTestContext());

    await expect(caller.update({ id: A, day: 32 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(asMock(updateCommitment).mock.calls).toHaveLength(0);
  });

  test("another team's commitment for a payment is a bad request", async () => {
    asMock(setTransactionCommitment).mockImplementation(() =>
      Promise.reject(new CommitmentInputError("not this team's")),
    );
    const caller = createCaller(createTestContext());

    await expect(
      caller.setForTransaction({ transactionId: A, commitmentId: B }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("'part of no commitment' can be said about a payment", async () => {
    const caller = createCaller(createTestContext());

    await caller.setForTransaction({ transactionId: A, commitmentId: null });

    expect(asMock(setTransactionCommitment).mock.calls[0]?.[1]).toEqual({
      transactionId: A,
      commitmentId: null,
      teamId: "test-team-id",
    });
  });
});
