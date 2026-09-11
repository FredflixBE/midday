import {
  connectYukiSchema,
  createPlatformLinkTokenSchema,
  disconnectAppSchema,
  updateAppSettingsSchema,
  verifyYukiSchema,
} from "@api/schemas/apps";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { getFeatureAvailability } from "@api/utils/availability";
import {
  createPlatformLinkToken,
  disconnectApp,
  getApps,
  updateAppSettings,
  updateAppSettingsBulk,
} from "@midday/db/queries";
import { verifyAccess, YukiAccessError, YukiRequestError } from "@midday/yuki";
import { connectYuki, withoutAccessKey } from "@midday/yuki/team";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * Runs a call to Yuki and says what went wrong in the user's terms: a refused
 * key or region is theirs to fix, anything else Yuki answered is not.
 */
async function withYukiErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof YukiAccessError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    if (error instanceof YukiRequestError) {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: `Yuki answered with an error: ${error.message}`,
        cause: error,
      });
    }
    throw error;
  }
}

export const appsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    // Every route here that hands back a row drops Yuki's key first.
    const apps = await getApps(db, teamId!);
    return apps.map(withoutAccessKey);
  }),

  /**
   * Which optional features this deployment has credentials for, so the
   * dashboard can leave out a card whose connect button would only fail.
   */
  availability: protectedProcedure.query(() => getFeatureAvailability()),

  disconnect: protectedProcedure
    .input(disconnectAppSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId } = input;

      const row = await disconnectApp(db, { appId, teamId: teamId! });
      return row && withoutAccessKey(row);
    }),

  update: protectedProcedure
    .input(updateAppSettingsSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId, option } = input;

      const row = await updateAppSettings(db, {
        appId,
        teamId: teamId!,
        option,
      });
      return withoutAccessKey(row);
    }),

  updateSettings: protectedProcedure
    .input(
      z.object({
        appId: z.string(),
        settings: z.array(
          z.object({
            id: z.string(),
            label: z.string().optional(),
            description: z.string().optional(),
            type: z.string().optional(),
            required: z.boolean().optional(),
            value: z.unknown(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId, settings } = input;

      const row = await updateAppSettingsBulk(db, {
        appId,
        teamId: teamId!,
        settings,
      });
      return withoutAccessKey(row);
    }),

  /**
   * Checks a Yuki access key, read-only, and names the administrations it can
   * read so the user can confirm the company. Saves nothing.
   */
  verifyYuki: protectedProcedure
    .input(verifyYukiSchema)
    .mutation(({ input }) => withYukiErrors(() => verifyAccess(input))),

  /** Checks the key again, then connects Yuki to this team, key encrypted. */
  connectYuki: protectedProcedure
    .input(connectYukiSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      withYukiErrors(() =>
        connectYuki(db, { ...input, teamId: teamId!, userId: session.user.id }),
      ),
    ),

  createPlatformLinkToken: protectedProcedure
    .input(createPlatformLinkTokenSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return createPlatformLinkToken(db, {
        provider: input.provider,
        teamId: teamId!,
        userId: session.user.id,
      });
    }),
});
