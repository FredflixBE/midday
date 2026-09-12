import {
  connectYukiCardSchema,
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
  createYukiCardConnection,
  disconnectApp,
  getApps,
  getYukiCardConnections,
  updateAppSettings,
  updateAppSettingsBulk,
  yukiInstitutionId,
} from "@midday/db/queries";
import {
  fetchGLAccountScheme,
  findCardGLAccounts,
  verifyAccess,
  YukiAccessError,
  YukiRequestError,
} from "@midday/yuki";
import {
  connectYuki,
  withoutAccessKey,
  YukiNotConnectedError,
  yukiClientForTeam,
} from "@midday/yuki/team";
import { tasks } from "@trigger.dev/sdk";
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

  /**
   * The cards this team could link, found in its own Yuki (FF-1517).
   *
   * A team without the Yuki app gets an empty list rather than an error: the
   * connect flow uses this to decide whether to offer the option at all, and a
   * team that has not connected Yuki must see no trace of it anywhere.
   */
  yukiCardAccounts: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      let client: Awaited<ReturnType<typeof yukiClientForTeam>>;
      try {
        client = await yukiClientForTeam(db, teamId!);
      } catch (error) {
        if (error instanceof YukiNotConnectedError) return { accounts: [] };
        throw error;
      }

      const [scheme, linked] = await Promise.all([
        withYukiErrors(() => fetchGLAccountScheme(client)),
        getYukiCardConnections(db, { teamId: teamId! }),
      ]);

      const linkedCodes = new Set(linked.map((card) => card.glAccountCode));

      return {
        accounts: findCardGLAccounts(scheme).map((account) => ({
          glAccountCode: account.code,
          name: account.description,
          // Connecting the same card twice is refused, so the option is shown
          // as already linked rather than offered and then rejected.
          linked: linkedCodes.has(account.code),
        })),
      };
    },
  ),

  /**
   * Links one card as a bank connection, and starts its first sync.
   *
   * The connection carries no row in the shared `institutions` table: that
   * table is global, so an entry there would put Yuki in every other team's
   * bank search.
   */
  connectYukiCard: protectedProcedure
    .input(connectYukiCardSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      const client = await yukiClientForTeam(db, teamId!).catch((error) => {
        if (error instanceof YukiNotConnectedError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Connect Yuki first, then link a card from it.",
          });
        }
        throw error;
      });

      const scheme = await withYukiErrors(() => fetchGLAccountScheme(client));
      const card = findCardGLAccounts(scheme).find(
        (account) => account.code === input.glAccountCode,
      );

      if (!card) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "That account is not a card in this administration. Pick one of the cards listed.",
        });
      }

      const created = await createYukiCardConnection(db, {
        teamId: teamId!,
        userId: session.user.id,
        glAccountCode: card.code,
        cardName: card.description,
        // The card's ledger is booked in the administration's own currency,
        // which on every Yuki region — Belgium and the Netherlands — is euro.
        currency: "EUR",
      });

      if (!created) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That card is already connected.",
        });
      }

      // Not `initial-bank-setup`: there is no open-banking provider to set up,
      // and no per-team schedule to create — the one Yuki schedule already
      // covers every team that has the app.
      await tasks.trigger("yuki-sync-card-charges", {
        teamId: teamId!,
        connectionId: created.connectionId,
      });

      return {
        ...created,
        institutionId: yukiInstitutionId(card.code),
        name: card.description,
      };
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
