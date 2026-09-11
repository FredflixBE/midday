import { NotFoundError, schedules } from "@trigger.dev/sdk";

const PAGE_SIZE = 200;

/**
 * Delete every schedule attached to one of these ids, whatever task it runs.
 *
 * A schedule is found by the `externalId` it carries — the team id for a bank
 * sync, the inbox account id for an inbox sync — rather than by a stored
 * schedule id: the bank schedule's id is stored nowhere, and an inbox
 * account's is missing if its setup died between creating the schedule and
 * saving the id.
 *
 * Returns how many it deleted. A schedule that disappears between the list and
 * the delete is already what we wanted.
 */
export async function deleteSchedulesFor(externalIds: string[]) {
  const ids = new Set(externalIds);
  const matching: string[] = [];

  // Collect first and delete afterwards: deleting while paging shifts the
  // pages under the loop.
  let page = 1;
  let totalPages = 1;

  do {
    const result = await schedules.list({ page, perPage: PAGE_SIZE });

    for (const schedule of result.data) {
      if (schedule.externalId && ids.has(schedule.externalId)) {
        matching.push(schedule.id);
      }
    }

    totalPages = result.pagination?.totalPages ?? 1;
    page++;
  } while (page <= totalPages);

  let deleted = 0;

  for (const id of matching) {
    try {
      await schedules.del(id);
      deleted++;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  return deleted;
}
