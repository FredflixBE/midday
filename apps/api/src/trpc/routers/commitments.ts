import {
  listCommitmentsSchema,
  setTransactionCommitmentSchema,
  updateCommitmentSchema,
} from "@api/schemas/commitments";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  CommitmentInputError,
  getCommitments,
  setTransactionCommitment,
  updateCommitment,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";

/**
 * Recurring commitments (FF-1591): what detection proposed, and a person's
 * corrections to it. Detection itself runs in enrichment and in the
 * `detect-commitments` script, never from a request.
 */

function asUserError(error: unknown): never {
  if (error instanceof CommitmentInputError) {
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

export const commitmentsRouter = createTRPCRouter({
  /** A team's commitments, or one supplier's, with the payments behind each. */
  list: protectedProcedure
    .input(listCommitmentsSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getCommitments(db, {
        teamId: teamId!,
        supplierId: input?.supplierId,
      });
    }),

  /** Confirm, reject, end, or correct what detection read. */
  update: protectedProcedure
    .input(updateCommitmentSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await updateCommitment(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),

  /** A person's answer for one payment. Detection never moves it again. */
  setForTransaction: protectedProcedure
    .input(setTransactionCommitmentSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await setTransactionCommitment(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),
});
