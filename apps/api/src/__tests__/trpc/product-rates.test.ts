/**
 * The product rates router's own behaviour (FF-1620): scoped to the caller's
 * team, a rate checked before it reaches the database, and another team's
 * customer or product not found. What the queries do is tested against a
 * database in packages/db.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  getCustomerProductRates,
  setCustomerProductRate,
} from "@midday/db/queries";
import { createCallerFactory } from "../../trpc/init";
import { productRatesRouter } from "../../trpc/routers/product-rates";
import { createTestContext } from "../helpers/test-context";
import { asMock } from "../setup";

const createCaller = createCallerFactory(productRatesRouter);

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "a1b2c3d4-0000-4000-8000-000000000002";

describe("tRPC: productRates", () => {
  beforeEach(() => {
    for (const fn of [getCustomerProductRates, setCustomerProductRate]) {
      asMock(fn).mockReset();
      asMock(fn).mockImplementation(() => Promise.resolve({}));
    }
  });

  test("a customer's rate can be cleared, so the product's price applies again", async () => {
    const caller = createCaller(createTestContext());

    await caller.setCustomerRate({
      customerId: A,
      productId: B,
      hourlyRate: null,
    });

    expect(asMock(setCustomerProductRate).mock.calls[0]?.[1]).toEqual({
      customerId: A,
      productId: B,
      hourlyRate: null,
      teamId: "test-team-id",
    });
  });

  test("a negative rate or a fraction of a cent is refused before the database", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.setCustomerRate({ customerId: A, productId: B, hourlyRate: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.setCustomerRate({
        customerId: A,
        productId: B,
        hourlyRate: 1.005,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(asMock(setCustomerProductRate).mock.calls).toHaveLength(0);
  });

  test("another team's customer or product is not found", async () => {
    asMock(setCustomerProductRate).mockImplementation(() =>
      Promise.resolve(null),
    );
    const caller = createCaller(createTestContext());

    await expect(
      caller.setCustomerRate({ customerId: A, productId: B, hourlyRate: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
