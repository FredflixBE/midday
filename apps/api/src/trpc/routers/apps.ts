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
import { connectYuki, YUKI_APP_ID } from "@midday/yuki/team";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * The dashboard reads every app row through `get`. Yuki's key stays behind:
 * a connection is shown by its administration, never by its key, encrypted
 * or not.
 */
function withoutSecrets<T extends { app_id: string; config: unknown }>(
  app: T,
): T {
  if (app.app_id !== YUKI_APP_ID || !app.config) return app;

  const { encryptedAccessKey: _, ...config } = app.config as Record<
    string,
    unknown
  >;
  return { ...app, config };
}

/** A refusal is the user's to fix; anything else Yuki said is not. */
function toTRPCError(error: unknown): unknown {
  if (error instanceof YukiAccessError) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof YukiRequestError) {
    return new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: `Yuki answered with an error: ${error.message}`,
      cause: error,
    });
  }
  return error;
}

export const appsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    const apps = await getApps(db, teamId!);
    return apps.map(withoutSecrets);
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

      return disconnectApp(db, { appId, teamId: teamId! });
    }),

  update: protectedProcedure
    .input(updateAppSettingsSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId, option } = input;

      return updateAppSettings(db, {
        appId,
        teamId: teamId!,
        option,
      });
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

      return updateAppSettingsBulk(db, {
        appId,
        teamId: teamId!,
        settings,
      });
    }),

  /**
   * Checks a Yuki access key, read-only, and names the administrations it can
   * read so the user can confirm the company. Saves nothing.
   */
  verifyYuki: protectedProcedure
    .input(verifyYukiSchema)
    .mutation(async ({ input }) => {
      try {
        return await verifyAccess(input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** Checks the key again, then connects Yuki to this team, key encrypted. */
  connectYuki: protectedProcedure
    .input(connectYukiSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        return await connectYuki(db, {
          ...input,
          teamId: teamId!,
          userId: session.user.id,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

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
