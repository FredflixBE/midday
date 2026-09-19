import {
  customerProductRatesSchema,
  setCustomerProductRateSchema,
} from "@api/schemas/product-rates";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  getCustomerProductRates,
  ProductRateInputError,
  setCustomerProductRate,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";

/**
 * A customer's own hourly rate per product (FF-1620), which a quote prices
 * from before the product's own price.
 */
export const productRatesRouter = createTRPCRouter({
  customerRates: protectedProcedure
    .input(customerProductRatesSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getCustomerProductRates(db, { ...input, teamId: teamId! });
    }),

  setCustomerRate: protectedProcedure
    .input(setCustomerProductRateSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const result = await setCustomerProductRate(db, {
        ...input,
        teamId: teamId!,
      }).catch((error: unknown) => {
        if (error instanceof ProductRateInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      });
      if (result === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
      }
      return result;
    }),
});
