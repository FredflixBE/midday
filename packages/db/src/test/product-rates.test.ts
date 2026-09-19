/**
 * Seam under test: a customer's own hourly rate per product (FF-1620), which
 * a quote prices from before the product's own price.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml; see
 * suppliers.test.ts for how to run it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { createInvoiceProduct } from "../queries/invoice-products";
import {
  getCustomerProductRates,
  ProductRateInputError,
  setCustomerProductRate,
} from "../queries/product-rates";
import { customers, invoiceProducts } from "../schema";
import {
  seedAll,
  TEAM_EUR_ID,
  TEAM_USD_ID,
  TEST_USER_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

describe.skipIf(SKIP)("product rates", () => {
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

  function create(name: string, price = 100, teamId = TEAM_USD_ID) {
    return createInvoiceProduct(db, {
      teamId,
      createdBy: TEST_USER_ID,
      name,
      price,
      currency: "USD",
      unit: "hour",
    });
  }

  test("a rate cannot be negative", async () => {
    const product = await create("Development", 110);
    const c = await customer();

    await expect(
      setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        productId: product.id,
        hourlyRate: -1,
      }),
    ).rejects.toBeInstanceOf(ProductRateInputError);
  });

  describe("a customer's own rates", () => {
    test("a customer can have its own rate, and clearing it brings back the default", async () => {
      const product = await create("Development", 110);
      const c = await customer();

      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        productId: product.id,
        hourlyRate: 95,
      });
      expect(
        await getCustomerProductRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([{ productId: product.id, hourlyRate: 95 }]);

      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        productId: product.id,
        hourlyRate: 100,
      });
      expect(
        await getCustomerProductRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([{ productId: product.id, hourlyRate: 100 }]);

      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        productId: product.id,
        hourlyRate: null,
      });
      expect(
        await getCustomerProductRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([]);
    });

    test("one customer's rate is not another's", async () => {
      const product = await create("Development", 110);
      const c1 = await customer();
      const c2 = await customer();

      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c1,
        productId: product.id,
        hourlyRate: 95,
      });

      expect(
        await getCustomerProductRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c2,
        }),
      ).toEqual([]);
    });

    test("a rate for another team's customer or product is not found", async () => {
      const ours = await create("Development", 110);
      const theirs = await create("Development", 110, TEAM_EUR_ID);
      const ourCustomer = await customer();
      const theirCustomer = await customer(TEAM_EUR_ID);

      expect(
        await setCustomerProductRate(db, {
          teamId: TEAM_USD_ID,
          customerId: theirCustomer,
          productId: ours.id,
          hourlyRate: 1,
        }),
      ).toBeNull();
      expect(
        await setCustomerProductRate(db, {
          teamId: TEAM_USD_ID,
          customerId: ourCustomer,
          productId: theirs.id,
          hourlyRate: 1,
        }),
      ).toBeNull();
      expect(
        await getCustomerProductRates(db, {
          teamId: TEAM_EUR_ID,
          customerId: theirCustomer,
        }),
      ).toEqual([]);
    });

    test("an inactive product's customer rate still resolves", async () => {
      const product = await create("Development", 110);
      const c = await customer();
      await setCustomerProductRate(db, {
        teamId: TEAM_USD_ID,
        customerId: c,
        productId: product.id,
        hourlyRate: 95,
      });

      await db
        .update(invoiceProducts)
        .set({ isActive: false })
        .where(eq(invoiceProducts.id, product.id));

      expect(
        await getCustomerProductRates(db, {
          teamId: TEAM_USD_ID,
          customerId: c,
        }),
      ).toEqual([{ productId: product.id, hourlyRate: 95 }]);
    });
  });
});
