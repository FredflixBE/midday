import { createAdminClient } from "@api/services/supabase";
import { isTeamPath } from "@api/utils/team-path";
import type { DropQuoteImages } from "@midday/db/queries";

/**
 * Letting go of the pictures a quote's text no longer holds (FF-1626).
 *
 * Which pictures those are is the queries' decision — a picture is let go
 * of only once no version of any of the team's quotes names it, so one a
 * sent version still draws stays. This is only the hands: it removes what it
 * is given, from the team's own folder and nowhere else.
 */
export function dropQuoteImages(teamId: string): DropQuoteImages {
  return async (paths) => {
    const own = paths.filter((path) => isTeamPath(teamId, path));
    if (own.length === 0) return;

    const supabase = await createAdminClient();
    const { error } = await supabase.storage.from("vault").remove(own);
    if (error) throw error;
  };
}
