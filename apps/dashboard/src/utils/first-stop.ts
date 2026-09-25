type SignedInUser = {
  fullName: string | null;
  teamId: string | null;
};

/**
 * Where a signed-in user has to go before the app itself, or null when
 * nothing stands in the way.
 *
 * A user without a team goes to /teams, never straight to onboarding: that
 * page shows their pending invites and any team they can pick, and sends
 * someone with neither on to onboarding. Onboarding creates a team, so an
 * invited user sent there first ends up working in an empty team of their
 * own while the invite waits (FF-1542).
 */
export function firstStop(
  user: SignedInUser | null | undefined,
): "/teams" | "/onboarding" | null {
  if (!user) return "/onboarding";
  if (!user.teamId) return "/teams";
  if (!user.fullName) return "/onboarding";
  return null;
}
