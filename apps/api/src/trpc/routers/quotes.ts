import {
  acceptQuoteSchema,
  addQuoteTermsSchema,
  createQuoteSchema,
  listQuotesSchema,
  markQuoteSentSchema,
  quoteIdSchema,
  quoteTermsIdSchema,
  reviseQuoteSchema,
  setQuoteOutcomeSchema,
  updateQuoteDraftSchema,
  updateQuoteSettingsSchema,
} from "@api/schemas/quotes";
import { dropQuoteImages } from "@api/services/quote-images";
import { storeQuotePdf } from "@api/services/quote-pdf";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  acceptQuoteVersion,
  addQuoteTerms,
  createQuote,
  deleteQuoteTerms,
  getQuote,
  getQuoteSettings,
  listQuotes,
  listQuoteTerms,
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
        await updateQuoteDraft(db, {
          ...input,
          teamId: teamId!,
          // A picture taken out of the text is taken out of the vault too,
          // once nothing else names it (FF-1626).
          dropImages: dropQuoteImages(teamId!),
        }).catch(asUserError),
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
   * its pricing at this moment, the one sent before it is superseded, and
   * its PDF is kept (FF-1615). A PDF that cannot be stored refuses the send:
   * a sent version nobody can produce the file for is worse.
   */
  markSent: protectedProcedure
    .input(markQuoteSentSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await markQuoteVersionSent(db, {
          teamId: teamId!,
          versionId: input.versionId,
          sentTo: input.sentTo || null,
          storePdf: storeQuotePdf(teamId!, input.versionId),
        }).catch(asUserError),
      );
    }),

  /**
   * The client said yes (FF-1615): the version is accepted and the quote is
   * won. Recording it again on the same version corrects what was recorded.
   */
  accept: protectedProcedure
    .input(acceptQuoteSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await acceptQuoteVersion(db, {
          ...input,
          teamId: teamId!,
          storePdf: storeQuotePdf(teamId!, input.versionId),
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

  /** The team's general terms versions, newest first (FF-1616). */
  terms: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return listQuoteTerms(db, { teamId: teamId! });
  }),

  /** A new version of the terms; the newest is what a quote is sent with. */
  addTerms: protectedProcedure
    .input(addQuoteTermsSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return addQuoteTerms(db, { ...input, teamId: teamId! }).catch(
        asUserError,
      );
    }),

  /** A wrong upload, before a quote was sent with it. */
  deleteTerms: protectedProcedure
    .input(quoteTermsIdSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return found(
        await deleteQuoteTerms(db, { ...input, teamId: teamId! }).catch(
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
