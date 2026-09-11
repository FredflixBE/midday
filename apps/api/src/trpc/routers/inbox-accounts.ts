import {
  connectInboxAccountSchema,
  deleteInboxAccountSchema,
  exchangeCodeForAccountSchema,
  syncInboxAccountSchema,
} from "@api/schemas/inbox-accounts";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  deleteInboxAccount,
  getInboxAccountById,
  getInboxAccounts,
} from "@midday/db/queries";
import { InboxConnector } from "@midday/inbox/connector";
import { encryptOAuthState } from "@midday/inbox/utils";
import { createLoggerWithContext } from "@midday/logger";
import { schedules, tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";

const logger = createLoggerWithContext("trpc:inbox-accounts");

export const inboxAccountsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getInboxAccounts(db, teamId!);
  }),

  connect: protectedProcedure
    .input(connectInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      if (!teamId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Team not found",
        });
      }

      try {
        // Encrypt state to prevent tampering with teamId
        const state = encryptOAuthState({
          teamId,
          provider: input.provider,
          source: "inbox",
          redirectPath: input.redirectPath,
        });

        const connector = new InboxConnector(input.provider, db);
        return connector.connect(state);
      } catch (error) {
        logger.error("Failed to connect to inbox account", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to connect to inbox account",
        });
      }
    }),

  exchangeCodeForAccount: protectedProcedure
    .input(exchangeCodeForAccountSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      try {
        const connector = new InboxConnector(input.provider, db);

        const account = await connector.exchangeCodeForAccount({
          code: input.code,
          teamId: teamId!,
        });

        return account;
      } catch (error) {
        logger.error("Failed to exchange code for account", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to exchange code for account",
        });
      }
    }),

  delete: protectedProcedure
    .input(deleteInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const data = await deleteInboxAccount(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!data) {
        return null;
      }

      // The row is gone by now, so neither failure below is worth failing the
      // request for: the user could not retry it. A schedule that survives
      // removes itself the next time it runs and finds no account.
      if (data.scheduleId) {
        try {
          await schedules.del(data.scheduleId);
        } catch (error) {
          logger.warn("Failed to delete inbox account schedule", {
            accountId: data.id,
            scheduleId: data.scheduleId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      try {
        // Inside the try: the connector throws on construction when the
        // provider's OAuth credentials are not configured.
        await new InboxConnector(data.provider, db).revokeAccess({
          email: data.email,
          refreshToken: data.refreshToken,
        });
      } catch (error) {
        logger.warn("Failed to revoke inbox access at the provider", {
          accountId: data.id,
          provider: data.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return { id: data.id, scheduleId: data.scheduleId };
    }),

  sync: protectedProcedure
    .input(syncInboxAccountSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      // Verify the inbox account belongs to the caller's team
      const account = await getInboxAccountById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!account) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Inbox account not found",
        });
      }

      const event = await tasks.trigger("sync-inbox-account", {
        id: input.id,
        manualSync: input.manualSync || false,
      });

      return event;
    }),
});
