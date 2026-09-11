import type { Attachment } from "./types";

/**
 * Messages read at once. Every call a read makes costs 5 of Gmail's 250
 * quota units a second per user, and a message takes one call plus one per
 * PDF, up to five: five messages at a time stay at 150 even when every one
 * of them carries five PDFs.
 */
const MESSAGES_AT_A_TIME = 5;

/**
 * Read the attachments of these messages, a few at a time. A message that no
 * longer exists is passed over; any other failure rejects, so that no caller
 * counts a message as read when it was not.
 */
export async function readMessages<Message>(
  messageIds: string[],
  read: {
    message: (id: string) => Promise<Message>;
    attachments: (message: Message) => Promise<Attachment[]>;
    isNotFound: (error: unknown) => boolean;
  },
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];

  for (let i = 0; i < messageIds.length; i += MESSAGES_AT_A_TIME) {
    const chunk = await Promise.all(
      messageIds.slice(i, i + MESSAGES_AT_A_TIME).map(async (id) => {
        let message: Message;
        try {
          message = await read.message(id);
        } catch (error: unknown) {
          // Deleted since it was listed: there is nothing left to read.
          if (read.isNotFound(error)) return [];
          throw error;
        }
        return read.attachments(message);
      }),
    );

    attachments.push(...chunk.flat());
  }

  return attachments;
}
