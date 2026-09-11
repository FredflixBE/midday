import { updateUserSchema } from "@api/schemas/users";
import { createAdminClient } from "@api/services/supabase";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { startTeamCleanup } from "@api/utils/team-cleanup";
import { teamCache } from "@midday/cache/team-cache";
import {
  deleteUser,
  getSoleMemberTeamIds,
  getUserById,
  getUserInvites,
  switchUserTeam,
  updateUser,
} from "@midday/db/queries";
import { generateFileKey } from "@midday/encryption";
import { getResend, isResendConfigured } from "@midday/utils/resend";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * Drops the user from the Resend audience when both the key and the audience
 * are configured; a self-hosted instance without either still deletes the user.
 */
function removeFromResendAudience(email: string) {
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!isResendConfigured() || !audienceId) {
    return Promise.resolve();
  }

  return getResend().contacts.remove({ email, audienceId });
}

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    const result = await getUserById(db, session.user.id);

    if (!result) {
      return undefined;
    }

    return {
      ...result,
      fileKey: result.teamId ? await generateFileKey(result.teamId) : null,
    };
  }),

  update: protectedProcedure
    .input(updateUserSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      return updateUser(db, {
        id: session.user.id,
        ...input,
      });
    }),

  switchTeam: protectedProcedure
    .input(z.object({ teamId: z.string().uuid() }))
    .mutation(async ({ ctx: { db, session }, input }) => {
      let result: Awaited<ReturnType<typeof switchUserTeam>>;

      try {
        result = await switchUserTeam(db, {
          userId: session.user.id,
          teamId: input.teamId,
        });
      } catch {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of this team",
        });
      }

      try {
        await Promise.all([
          teamCache.invalidateForUser(session.user.id, result.previousTeamId),
          teamCache.invalidateForUser(session.user.id, input.teamId),
        ]);
      } catch {
        // Non-fatal — cache will expire naturally
      }

      return result;
    }),

  delete: protectedProcedure.mutation(async ({ ctx: { db, session } }) => {
    const supabaseAdmin = await createAdminClient();

    // The teams only this user belongs to are deleted with them, and need the
    // same cleanup as a team deleted from its settings — started first, so
    // that a Trigger.dev outage leaves the account and its teams intact.
    const soleTeamIds = await getSoleMemberTeamIds(db, session.user.id);
    await Promise.all(
      soleTeamIds.map((teamId) => startTeamCleanup(db, teamId)),
    );

    const [data] = await Promise.all([
      deleteUser(db, session.user.id),
      supabaseAdmin.auth.admin.deleteUser(session.user.id),
      removeFromResendAudience(session.user.email!),
    ]);

    return data;
  }),

  invites: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    if (!session.user.email) {
      return [];
    }

    return getUserInvites(db, session.user.email);
  }),
});
