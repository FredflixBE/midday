import { getDb } from "@jobs/init";
import { updateInboxAccount } from "@midday/db/queries";
import {
  assertInboxAuthError,
  InboxSyncError,
  isInboxAuthError,
} from "@midday/inbox/errors";
import { logger } from "@trigger.dev/sdk";

/**
 * Log a failed read of a mailbox, and mark the account disconnected when the
 * failure needs the user to connect it again. Any other failure leaves the
 * account's status alone, for the run's retries to deal with.
 */
export async function recordSyncFailure(
  error: unknown,
  context: { accountId: string; provider: string },
): Promise<void> {
  const { accountId, provider } = context;

  // Handle structured InboxAuthError
  if (isInboxAuthError(error)) {
    // Use assertion to narrow type without casting
    assertInboxAuthError(error);

    logger.error("Inbox sync failed - authentication error", {
      accountId,
      errorCode: error.code,
      errorMessage: error.message,
      requiresReauth: error.requiresReauth,
      provider: error.provider,
    });

    if (error.requiresReauth) {
      // Mark as disconnected - user needs to re-authenticate
      await updateInboxAccount(getDb(), {
        id: accountId,
        status: "disconnected",
        errorMessage: `Authentication failed (${error.code}): ${error.message}`,
      });

      logger.error("Account marked as disconnected - requires reauth", {
        accountId,
        errorCode: error.code,
        provider: error.provider,
      });
    } else {
      // Transient auth error - don't change status, let retry handle it
      logger.warn("Transient auth error - will retry", {
        accountId,
        errorCode: error.code,
        provider: error.provider,
      });
    }

    return;
  }

  // Handle structured InboxSyncError
  if (error instanceof InboxSyncError) {
    // Sync errors are typically transient - don't change connection status
    logger.warn("Inbox sync failed - sync error", {
      accountId,
      errorCode: error.code,
      errorMessage: error.message,
      isRetryable: error.isRetryable(),
      provider: error.provider,
    });
    return;
  }

  // For unknown errors, don't change connection status
  // These might be infrastructure issues that resolve on retry
  logger.error("Inbox sync failed - unknown error", {
    accountId,
    error: error instanceof Error ? error.message : "Unknown sync error",
    provider,
  });
}
