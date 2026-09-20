/**
 * True when a stored path is this team's own and stays inside its folder.
 *
 * A prefix test is not enough on its own: `<teamId>/../<other>/secret.png`
 * starts with the team and still walks out of it, and anything that
 * normalises the path afterwards — storage, a CDN, an S3 key — would follow
 * it. Used where a bad path should be passed over rather than refused, such
 * as the pictures a quote's text names (FF-1625).
 */
export function isTeamPath(teamId: string, filePath: string): boolean {
  const parts = filePath.split("/");

  if (parts.length < 2 || parts[0] !== teamId) {
    return false;
  }

  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
