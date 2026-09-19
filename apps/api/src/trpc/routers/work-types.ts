import {
  createWorkTypeSchema,
  customerWorkTypeRatesSchema,
  listWorkTypesSchema,
  reorderWorkTypesSchema,
  setCustomerWorkTypeRateSchema,
  updateWorkTypeSchema,
  workTypeIdSchema,
} from "@api/schemas/work-types";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
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
import { TRPCError } from "@trpc/server";

/**
 * Work types and their rates (FF-1607): the team's list with a default hourly
 * rate each, and a customer's own rate per type.
 */

function asUserError(error: unknown): never {
  if (error instanceof WorkTypeInputError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

function found<T>(value: T | null): T {
  if (value === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
  }
  return value;
}

export const workTypesRouter = createTRPCRouter({
  /** The list a person picks from; archived types only when asked for. */
  list: protectedProcedure
    .input(listWorkTypesSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getWorkTypes(db, {
        teamId: teamId!,
        includeArchived: input?.includeArchived,
      });
    }),

  create: protectedProcedure
    .input(createWorkTypeSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return createWorkType(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  /** Rename or reprice. */
  update: protectedProcedure
    .input(updateWorkTypeSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await updateWorkType(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),

  /** The whole list's order, as ids. */
  reorder: protectedProcedure
    .input(reorderWorkTypesSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      await reorderWorkTypes(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  archive: protectedProcedure
    .input(workTypeIdSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(await archiveWorkType(db, { ...input, teamId: teamId! }));
    }),

  restore: protectedProcedure
    .input(workTypeIdSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(await restoreWorkType(db, { ...input, teamId: teamId! }));
    }),

  customerRates: protectedProcedure
    .input(customerWorkTypeRatesSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getCustomerWorkTypeRates(db, { ...input, teamId: teamId! });
    }),

  setCustomerRate: protectedProcedure
    .input(setCustomerWorkTypeRateSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await setCustomerWorkTypeRate(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),
});
