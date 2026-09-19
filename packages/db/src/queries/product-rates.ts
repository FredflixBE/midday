import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { customerProductRates, customers, invoiceProducts } from "../schema";

/**
 * A customer's own hourly rate per product (FF-1620). A quote line picks a
 * product and is priced at its price per hour, unless the customer has a rate
 * of its own here, or the quote one in its content.
 */

/** A person's mistake, told apart from a failure so the API can say so. */
export class ProductRateInputError extends Error {}

/**
 * Every product of the team, inactive ones included so a quote line that
 * names one still prices, by name. What a quote needs of a product, no more.
 */
export async function getQuoteProducts(db: Database, teamId: string) {
  return db
    .select({
      id: invoiceProducts.id,
      name: invoiceProducts.name,
      price: invoiceProducts.price,
      currency: invoiceProducts.currency,
      unit: invoiceProducts.unit,
      isActive: invoiceProducts.isActive,
    })
    .from(invoiceProducts)
    .where(eq(invoiceProducts.teamId, teamId))
    .orderBy(asc(invoiceProducts.name));
}

/** The customer's own rates. A product without one uses its price. */
export async function getCustomerProductRates(
  db: Database,
  params: { teamId: string; customerId: string },
): Promise<{ productId: string; hourlyRate: number }[]> {
  return db
    .select({
      productId: customerProductRates.productId,
      hourlyRate: customerProductRates.hourlyRate,
    })
    .from(customerProductRates)
    .where(
      and(
        eq(customerProductRates.teamId, params.teamId),
        eq(customerProductRates.customerId, params.customerId),
      ),
    );
}

/**
 * Sets a customer's own rate for one product, or clears it with null so the
 * product's price applies again. Null when the customer or the product is not
 * the team's.
 */
export async function setCustomerProductRate(
  db: Database,
  params: {
    teamId: string;
    customerId: string;
    productId: string;
    hourlyRate: number | null;
  },
): Promise<{ productId: string; hourlyRate: number | null } | null> {
  return db.transaction(async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.id, params.customerId),
          eq(customers.teamId, params.teamId),
        ),
      );
    const [product] = await tx
      .select({ id: invoiceProducts.id })
      .from(invoiceProducts)
      .where(
        and(
          eq(invoiceProducts.id, params.productId),
          eq(invoiceProducts.teamId, params.teamId),
        ),
      );
    if (!customer || !product) return null;

    const key = and(
      eq(customerProductRates.customerId, params.customerId),
      eq(customerProductRates.productId, params.productId),
    );

    if (params.hourlyRate === null) {
      await tx.delete(customerProductRates).where(key);
      return { productId: params.productId, hourlyRate: null };
    }

    const hourlyRate = params.hourlyRate;
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      throw new ProductRateInputError("A rate cannot be negative");
    }
    await tx
      .insert(customerProductRates)
      .values({
        customerId: params.customerId,
        productId: params.productId,
        teamId: params.teamId,
        hourlyRate,
      })
      .onConflictDoUpdate({
        target: [
          customerProductRates.customerId,
          customerProductRates.productId,
        ],
        set: { hourlyRate },
      });
    return { productId: params.productId, hourlyRate };
  });
}
