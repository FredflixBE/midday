/**
 * Who counts as the developer of this installation.
 *
 * Settings → Admin starts maintenance jobs that touch the whole deployment
 * rather than one team's rows — re-fetching every bank, creating schedules,
 * generating invoices — so it is not a team-member power. A self-hosted fork
 * has no role above "team owner" to hang that on, and a single email address
 * in the environment is the smallest thing that works for one.
 *
 * **Unset means nobody.** Failing open would give every member of every team
 * the buttons, which is the thing this is here to prevent, and would do it
 * silently. Failing closed is visible the moment someone looks for the tab.
 *
 * Deliberately silent: this is asked on every settings page load, and the
 * refusal that matters is logged where it happens, in `developerProcedure`.
 */
export function isDeveloper(email: string | null | undefined): boolean {
  const developer = process.env.DEVELOPER_EMAIL?.trim().toLowerCase();

  if (!developer) return false;

  return !!email && email.trim().toLowerCase() === developer;
}
