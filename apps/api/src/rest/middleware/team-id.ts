import { teamPermissionsCache } from "@midday/cache/team-permissions-cache";
import { getUserTeamId } from "@midday/db/queries";
import { logger } from "@midday/logger";
import type { MiddlewareHandler } from "hono";

/**
 * Resolves the team for the request. Uses the teamId already set by withAuth
 * (from API key, OAuth token, or JWT) and only falls back to the user's active
 * team when auth did not set one.
 */
export const withTeamId: MiddlewareHandler = async (c, next) => {
  const session = c.get("session");
  const db = c.get("db");

  let teamId: string | null = c.get("teamId") || null;

  if (!teamId && session?.user?.id) {
    const cacheKey = `user:${session.user.id}:team`;
    teamId = (await teamPermissionsCache.get(cacheKey)) || null;

    if (!teamId) {
      try {
        const userTeamId = await getUserTeamId(db, session.user.id);

        if (userTeamId) {
          teamId = userTeamId;
          await teamPermissionsCache.set(cacheKey, userTeamId);
        }
      } catch (error) {
        logger.warn("Failed to fetch user team", {
          userId: session.user.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  c.set("teamId", teamId);

  await next();
};
