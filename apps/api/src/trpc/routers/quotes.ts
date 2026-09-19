import {
  createQuoteSchema,
  listQuotesSchema,
  markQuoteSentSchema,
  quoteIdSchema,
  reviseQuoteSchema,
  setQuoteOutcomeSchema,
  updateQuoteDraftSchema,
  updateQuoteSettingsSchema,
} from "@api/schemas/quotes";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  createQuote,
  getQuote,
  getQuoteSettings,
  listQuotes,
  markQuoteVersionSent,
  QuoteInputError,
  reviseQuote,
  setQuoteOutcome,
  updateQuoteDraft,
  updateQuoteSettings,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";

/**
 * Quotes and their versions (FF-1609). The version rules — only a draft is
 * edited, one draft at a time, revise copies the latest — are the queries';
 * breaking one comes back as a bad request.
 */

function asUserError(error: unknown): never {
  if (error instanceof QuoteInputError) {
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

export const quotesRouter = createTRPCRouter({
  /** A new quote with version 1 as a draft. */
  create: protectedProcedure
    .input(createQuoteSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      return found(
        await createQuote(db, {
          ...input,
          teamId: teamId!,
          userId: session.user.id,
        }).catch(asUserError),
      );
    }),

  /** One quote with its versions, newest first. */
  get: protectedProcedure
    .input(quoteIdSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return found(await getQuote(db, { id: input.id, teamId: teamId! }));
    }),

  updateDraft: protectedProcedure
    .input(updateQuoteDraftSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await updateQuoteDraft(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),

  /** The latest version copied into a new draft. */
  revise: protectedProcedure
    .input(reviseQuoteSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await reviseQuote(db, { ...input, teamId: teamId! }).catch(asUserError),
      );
    }),

  /**
   * Every quote with its latest version and the amount the list shows. The
   * content stays behind: the list does not need it, and it is the heavy part.
   */
  list: protectedProcedure
    .input(listQuotesSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      const rows = await listQuotes(db, {
        teamId: teamId!,
        status: input?.status,
      });
      return rows.map(
        ({ version: { content, pricing, ...version }, ...quote }) => ({
          ...quote,
          version,
        }),
      );
    }),

  /**
   * Marks a draft sent, as it went out by hand: the version is frozen with
   * its pricing at this moment, and the one sent before it is superseded.
   */
  markSent: protectedProcedure
    .input(markQuoteSentSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await markQuoteVersionSent(db, {
          teamId: teamId!,
          versionId: input.versionId,
          sentTo: input.sentTo || null,
        }).catch(asUserError),
      );
    }),

  /** Lost or no decision, with the reason; open takes it back. */
  setOutcome: protectedProcedure
    .input(setQuoteOutcomeSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await setQuoteOutcome(db, { ...input, teamId: teamId! }).catch(
          asUserError,
        ),
      );
    }),

  settings: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getQuoteSettings(db, teamId!);
  }),

  updateSettings: protectedProcedure
    .input(updateQuoteSettingsSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return updateQuoteSettings(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),
});
