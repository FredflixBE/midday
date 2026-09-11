/**
 * How far back a user may ask an inbox's first sync to reach, shared by the
 * date picker, the API and the sync job. Every PDF a sync finds is sent to a
 * model for extraction, so the reach is a cost the user chooses — within a
 * year.
 *
 * Dates are calendar days, as `YYYY-MM-DD`: the sync reads from midnight UTC
 * of that day.
 *
 * No dependencies on purpose: the dashboard imports this.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a sync looks when nothing says otherwise: a first sync the
 * user chose no date for, and a manual sync.
 */
export const DEFAULT_SYNC_DAYS = 30;

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDate(date: string): Date | null {
  const match = CALENDAR_DATE_PATTERN.exec(date);
  if (!match) return null;

  const [, year, month, day] = match.map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Date.UTC rolls 2026-02-30 over into March; a real date survives the trip.
  return parsed.getUTCMonth() === month - 1 ? parsed : null;
}

function toCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return toCalendarDate(
    new Date(parseCalendarDate(date)!.getTime() + days * DAY_MS),
  );
}

/** The same calendar day a year earlier; the 28th for a leap day. */
function yearBefore(date: string): string {
  const today = parseCalendarDate(date)!;
  const year = today.getUTCFullYear() - 1;
  const month = today.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return toCalendarDate(
    new Date(Date.UTC(year, month, Math.min(today.getUTCDate(), lastDay))),
  );
}

/**
 * The dates the picker offers, given the user's own today (`YYYY-MM-DD`).
 */
export function syncStartBounds(today: string): {
  earliest: string;
  latest: string;
  suggested: string;
} {
  return {
    earliest: yearBefore(today),
    latest: today,
    suggested: addDays(today, -DEFAULT_SYNC_DAYS),
  };
}

/**
 * Why a sync may not start from `since`, or null when it may.
 *
 * The server's today is UTC's, and the picker's is the user's, which can be a
 * day either side of it. So the server allows a day of slack at both ends
 * rather than refuse a date the picker offered.
 */
export function syncStartProblem(since: string, now: Date): string | null {
  if (!parseCalendarDate(since))
    return `${since} is not a date; use YYYY-MM-DD.`;

  const today = toCalendarDate(now);
  const earliest = yearBefore(today);

  if (since < addDays(earliest, -1)) {
    return `An inbox sync can reach back at most one year, to ${earliest}; ${since} is further back.`;
  }

  if (since > addDays(today, 1)) {
    return `An inbox sync cannot start in the future; ${since} is after ${today}.`;
  }

  return null;
}
