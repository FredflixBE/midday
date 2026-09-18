import {
  createSupplierSchema,
  deleteSupplierRuleSchema,
  deleteSupplierSchema,
  getSupplierByIdSchema,
  mergeSuppliersSchema,
  resetTransactionSupplierSchema,
  setTransactionSupplierSchema,
  supplierRuleSchema,
  updateSupplierSchema,
} from "@api/schemas/suppliers";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  createSupplier,
  deleteSupplier,
  deleteSupplierRule,
  getSupplierById,
  getSupplierRules,
  getSuppliers,
  getSupplierTransactions,
  mergeSuppliers,
  previewSupplierRule,
  resetTransactionSupplier,
  SupplierInputError,
  SupplierMergeError,
  SupplierNameTakenError,
  saveSupplierRule,
  setTransactionSupplier,
  updateSupplier,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";

/**
 * Suppliers, the rules that recognise them, and a person's answer on a single
 * payment (FF-1555).
 */

/** The refusals a person can act on, said as themselves rather than a 500. */
function asUserError(error: unknown): never {
  if (error instanceof SupplierNameTakenError) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (
    error instanceof SupplierMergeError ||
    error instanceof SupplierInputError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

/** A missing row is said as one, not returned as a quiet null. */
function found<T>(value: T | null): T {
  if (value === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
  }
  return value;
}

export const suppliersRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getSuppliers(db, { teamId: teamId! });
  }),

  getById: protectedProcedure
    .input(getSupplierByIdSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      const supplier = await getSupplierById(db, {
        teamId: teamId!,
        id: input.id,
      });

      if (!supplier) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such supplier" });
      }

      const rules = await getSupplierRules(db, {
        teamId: teamId!,
        supplierId: input.id,
      });

      return { ...supplier, rules };
    }),

  /** The payments behind a supplier's count. */
  transactions: protectedProcedure
    .input(getSupplierByIdSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getSupplierTransactions(db, {
        teamId: teamId!,
        supplierId: input.id,
      });
    }),

  /** The rules that say a text names nobody, which belong to no supplier. */
  collectiveRules: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getSupplierRules(db, { teamId: teamId!, supplierId: null });
  }),

  create: protectedProcedure
    .input(createSupplierSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return createSupplier(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  update: protectedProcedure
    .input(updateSupplierSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return updateSupplier(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  delete: protectedProcedure
    .input(deleteSupplierSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(await deleteSupplier(db, { id: input.id, teamId: teamId! }));
    }),

  merge: protectedProcedure
    .input(mergeSuppliersSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return mergeSuppliers(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  /** What a rule would take, before it is saved. Writes nothing. */
  previewRule: protectedProcedure
    .input(supplierRuleSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return previewSupplierRule(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  /** Save a rule and bring every payment a person has not decided in line. */
  saveRule: protectedProcedure
    .input(supplierRuleSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return saveSupplierRule(db, {
        ...input,
        teamId: teamId!,
        source: "manual",
      }).catch(asUserError);
    }),

  deleteRule: protectedProcedure
    .input(deleteSupplierRuleSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await deleteSupplierRule(db, { id: input.id, teamId: teamId! }),
      );
    }),

  /** A person's answer for one payment. Nothing automatic moves it again. */
  setForTransaction: protectedProcedure
    .input(setTransactionSupplierSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await setTransactionSupplier(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),

  /** Hand a payment back to the rules. */
  resetForTransaction: protectedProcedure
    .input(resetTransactionSupplierSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await resetTransactionSupplier(db, { ...input, teamId: teamId! }),
      );
    }),
});
