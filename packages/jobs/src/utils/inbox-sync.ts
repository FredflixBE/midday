/**
 * Messages read by one run of `sync-inbox-messages`. Small enough that a run
 * stays well inside its max duration and a medium-1x machine's memory with
 * five 10 MB attachments on every message, and that twenty messages fetched
 * at once stay under Gmail's per-user quota of 250 units a second.
 */
export const MESSAGES_PER_BATCH = 20;

export type MailboxSyncOptions = {
  /**
   * The account's watermark: every message received before it has been read.
   * Null for an account that has never synced.
   */
  lastAccessed: string | null;
  /** Backfill: read from this date (YYYY-MM-DD, UTC) instead. */
  since?: string;
  /** A manual or first sync, which looks back 30 days. */
  fullSync: boolean;
  /** When the sync began. The watermark moves here once everything is read. */
  startedAt: Date;
  listMessageIds: (since: Date) => Promise<string[]>;
  /**
   * Read one batch of messages. Resolves with the number of attachments sent
   * for processing, and throws when the batch could not be read.
   */
  syncBatch: (messageIds: string[]) => Promise<number>;
};

export type MailboxSyncResult = {
  since: Date;
  messages: number;
  attachmentsProcessed: number;
  /** The watermark to store, or null to leave it where it is. */
  lastAccessed: string | null;
  /** What stopped the sync short, when something did. */
  error?: unknown;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back a manual or first sync looks. */
const FULL_SYNC_DAYS = 30;

/**
 * The start of the sync's window. Without a backfill date that is the day
 * before the watermark — an overlap, which the dedup on reference ids makes
 * free — and, for a manual or first sync, never less than 30 days back.
 */
function windowStart(options: MailboxSyncOptions): Date {
  if (options.since) return new Date(`${options.since}T00:00:00Z`);

  const lookBack = new Date(
    options.startedAt.getTime() - FULL_SYNC_DAYS * DAY_MS,
  );
  if (!options.lastAccessed) return lookBack;

  const watermark = new Date(new Date(options.lastAccessed).getTime() - DAY_MS);
  return options.fullSync && lookBack < watermark ? lookBack : watermark;
}

/**
 * Read every message in the sync's window, a batch at a time, newest first.
 *
 * The watermark moves only when every message between it and the start of
 * the sync has been read: after a failed batch it stays where it was, and so
 * does it after a backfill that began later than it. The next sync reads the
 * same window again, and the dedup passes over what this one already did.
 *
 * A failed batch ends the sync. Its run has already retried, so what failed
 * it — a revoked token, a quota, a message that cannot be read — would most
 * likely fail every batch after it too.
 */
export async function syncMailbox(
  options: MailboxSyncOptions,
): Promise<MailboxSyncResult> {
  const since = windowStart(options);
  const messageIds = await options.listMessageIds(since);

  let attachmentsProcessed = 0;
  for (let i = 0; i < messageIds.length; i += MESSAGES_PER_BATCH) {
    try {
      attachmentsProcessed += await options.syncBatch(
        messageIds.slice(i, i + MESSAGES_PER_BATCH),
      );
    } catch (error) {
      return {
        since,
        messages: messageIds.length,
        attachmentsProcessed,
        lastAccessed: null,
        error,
      };
    }
  }

  const coversWatermark =
    !options.lastAccessed || since <= new Date(options.lastAccessed);

  return {
    since,
    messages: messageIds.length,
    attachmentsProcessed,
    lastAccessed: coversWatermark ? options.startedAt.toISOString() : null,
  };
}
