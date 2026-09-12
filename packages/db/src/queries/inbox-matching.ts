import { createLoggerWithContext } from "@midday/logger";
import { and, desc, eq, inArray, isNull, notLike, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { inbox, transactionMatchSuggestions } from "../schema";
import { createActivity } from "./activities";
import {
  fetchInboxWithTransaction,
  matchTransaction,
  updateInbox,
} from "./inbox";
import {
  createMatchSuggestion,
  findMatches,
  type MatchResult,
} from "./transaction-matching";

const logger = createLoggerWithContext("inbox-matching");

// Type guard to check if result has a suggestion
export function hasSuggestion(result: {
  action: "auto_matched" | "suggestion_created" | "no_match_yet";
  suggestion?: MatchResult;
}): result is {
  action: "auto_matched" | "suggestion_created";
  suggestion: MatchResult;
} {
  return result.action !== "no_match_yet" && result.suggestion !== undefined;
}

type PersistInboxSuggestionCandidate = Pick<
  MatchResult,
  | "transactionId"
  | "confidenceScore"
  | "amountScore"
  | "currencyScore"
  | "dateScore"
  | "nameScore"
  | "matchType"
>;

export async function persistInboxSuggestionWorkflow(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    candidate: PersistInboxSuggestionCandidate;
    source?: string;
  },
): Promise<{
  action: "auto_matched" | "suggestion_created";
}> {
  const { teamId, inboxId, candidate, source } = params;
  const shouldAutoMatch = candidate.matchType === "auto_matched";

  return db.transaction(async (tx) => {
    if (shouldAutoMatch) {
      await createMatchSuggestion(tx, {
        teamId,
        inboxId,
        transactionId: candidate.transactionId,
        confidenceScore: candidate.confidenceScore,
        amountScore: candidate.amountScore,
        currencyScore: candidate.currencyScore,
        dateScore: candidate.dateScore,
        nameScore: candidate.nameScore,
        matchType: "auto_matched",
        status: "confirmed",
        matchDetails: {
          autoMatched: true,
          calculatedAt: new Date().toISOString(),
          ...(source ? { source } : {}),
          criteria: {
            confidence: candidate.confidenceScore,
            amount: candidate.amountScore,
            currency: candidate.currencyScore,
            date: candidate.dateScore,
          },
        },
      });

      await matchTransaction(tx, {
        id: inboxId,
        transactionId: candidate.transactionId,
        teamId,
      });

      return { action: "auto_matched" as const };
    }

    const suggestionRow = await createMatchSuggestion(tx, {
      teamId,
      inboxId,
      transactionId: candidate.transactionId,
      confidenceScore: candidate.confidenceScore,
      amountScore: candidate.amountScore,
      currencyScore: candidate.currencyScore,
      dateScore: candidate.dateScore,
      nameScore: candidate.nameScore,
      matchType: candidate.matchType,
      status: "pending",
      matchDetails: {
        calculatedAt: new Date().toISOString(),
        ...(source ? { source } : {}),
        scores: {
          amount: candidate.amountScore,
          currency: candidate.currencyScore,
          date: candidate.dateScore,
          name: candidate.nameScore,
        },
      },
    });

    if (!suggestionRow) {
      logger.warn(
        "createMatchSuggestion no-op: existing row blocked upsert, resetting inbox to pending",
        { teamId, inboxId, transactionId: candidate.transactionId },
      );
      await updateInbox(tx, {
        id: inboxId,
        teamId,
        status: "pending",
      });
      return { action: "suggestion_created" as const };
    }

    await updateInbox(tx, {
      id: inboxId,
      teamId,
      status: "suggested_match",
    });

    return { action: "suggestion_created" as const };
  });
}

export function shouldResetInboxToPendingAfterSuggestionFailure(
  state: {
    status: string | null;
    transactionId: string | null;
  } | null,
): boolean {
  return state?.status === "analyzing" && !state.transactionId;
}

// Calculate and store suggestions for an inbox item
export async function calculateInboxSuggestions(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    excludeTransactionIds?: Set<string>;
  },
): Promise<{
  action: "auto_matched" | "suggestion_created" | "no_match_yet";
  suggestion?: MatchResult;
}> {
  const { teamId, inboxId, excludeTransactionIds } = params;

  try {
    // Set status to analyzing while we process
    await updateInbox(db, {
      id: inboxId,
      teamId,
      status: "analyzing",
    });

    // Find the best match using our matching algorithm
    const bestMatch = await findMatches(db, {
      teamId,
      inboxId,
      excludeTransactionIds,
    });

    if (!bestMatch) {
      // Update inbox status to pending - we'll keep looking when new transactions arrive
      // The no_match status is only set by the scheduler after 90 days
      await updateInbox(db, {
        id: inboxId,
        teamId,
        status: "pending",
      });

      return { action: "no_match_yet" };
    }

    const { action } = await persistInboxSuggestionWorkflow(db, {
      teamId,
      inboxId,
      candidate: bestMatch,
    });

    return {
      action,
      suggestion: bestMatch,
    };
  } catch (error) {
    // Best-effort recovery: avoid leaving items stuck in "analyzing".
    try {
      const [currentInbox] = await db
        .select({
          status: inbox.status,
          transactionId: inbox.transactionId,
        })
        .from(inbox)
        .where(and(eq(inbox.id, inboxId), eq(inbox.teamId, teamId)))
        .limit(1);

      if (
        shouldResetInboxToPendingAfterSuggestionFailure(currentInbox ?? null)
      ) {
        await updateInbox(db, {
          id: inboxId,
          teamId,
          status: "pending",
        });
      }
    } catch (rollbackError) {
      logger.error(
        "Failed to reset inbox after suggestion calculation failure",
        {
          teamId,
          inboxId,
          error:
            rollbackError instanceof Error
              ? rollbackError.message
              : "Unknown error",
        },
      );
    }

    throw error;
  }
}

// Confirm a suggested match
export async function confirmSuggestedMatch(
  db: Database,
  params: {
    teamId: string;
    suggestionId: string;
    inboxId: string;
    transactionId: string;
    userId?: string | null;
  },
) {
  const { teamId, suggestionId, inboxId, transactionId, userId } = params;

  return db.transaction(async (tx) => {
    // Check if already matched (idempotent — skip activity + matchTransaction)
    const [inboxState] = await tx
      .select({ transactionId: inbox.transactionId })
      .from(inbox)
      .where(and(eq(inbox.id, inboxId), eq(inbox.teamId, teamId)))
      .limit(1);

    const alreadyMatched = inboxState?.transactionId === transactionId;

    const [suggestion] = await tx
      .update(transactionMatchSuggestions)
      .set({
        status: "confirmed",
        userActionAt: new Date().toISOString(),
        userId,
      })
      .where(
        and(
          eq(transactionMatchSuggestions.id, suggestionId),
          eq(transactionMatchSuggestions.teamId, teamId),
        ),
      )
      .returning();

    let result: Awaited<ReturnType<typeof matchTransaction>>;

    if (alreadyMatched) {
      result = await fetchInboxWithTransaction(tx, inboxId, teamId);
    } else {
      result = await matchTransaction(tx, {
        id: inboxId,
        transactionId,
        teamId,
      });

      await createActivity(tx, {
        teamId,
        userId: userId ?? undefined,
        type: "inbox_match_confirmed",
        source: "user",
        priority: 7,
        metadata: {
          inboxId,
          transactionId: result?.transactionId,
          documentName: result?.displayName,
          amount: result?.amount,
          currency: result?.currency,
          confidenceScore: Number(suggestion?.confidenceScore),
        },
      });
    }

    // Confirm pending suggestions for inbox items that were matched as part
    // of this group — only where the inbox item now points to this transaction
    await tx
      .update(transactionMatchSuggestions)
      .set({
        status: "confirmed",
        userActionAt: new Date().toISOString(),
        userId,
      })
      .where(
        and(
          eq(transactionMatchSuggestions.transactionId, transactionId),
          eq(transactionMatchSuggestions.teamId, teamId),
          eq(transactionMatchSuggestions.status, "pending"),
          sql`${transactionMatchSuggestions.inboxId} IN (
            SELECT ${inbox.id} FROM ${inbox}
            WHERE ${inbox.transactionId} = ${transactionId}
              AND ${inbox.teamId} = ${teamId}
          )`,
        ),
      );

    return result;
  });
}

// Decline a suggested match
export async function declineSuggestedMatch(
  db: Database,
  params: {
    suggestionId: string;
    inboxId: string;
    userId?: string | null;
    teamId: string;
  },
) {
  const { suggestionId, inboxId, userId, teamId } = params;

  await db.transaction(async (tx) => {
    await tx
      .update(transactionMatchSuggestions)
      .set({
        status: "declined",
        userActionAt: new Date().toISOString(),
        userId,
      })
      .where(
        and(
          eq(transactionMatchSuggestions.id, suggestionId),
          eq(transactionMatchSuggestions.teamId, teamId),
        ),
      );

    await updateInbox(tx, {
      id: inboxId,
      teamId,
      status: "pending",
    });
  });
}

// Get inbox items by status for easier querying
export async function getInboxByStatus(
  db: Database,
  params: {
    teamId: string;
    status?:
      | "processing"
      | "pending"
      | "archived"
      | "new"
      | "analyzing"
      | "suggested_match"
      | "no_match"
      | "done"
      | "deleted"
      | "other"
      | "failed";
  },
) {
  const { teamId, status } = params;

  const baseQuery = db
    .select({
      id: inbox.id,
      displayName: inbox.displayName,
      amount: inbox.amount,
      currency: inbox.currency,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      transactionId: inbox.transactionId,
    })
    .from(inbox);

  if (status) {
    return baseQuery
      .where(and(eq(inbox.teamId, teamId), eq(inbox.status, status)))
      .orderBy(desc(inbox.createdAt));
  }

  return baseQuery
    .where(eq(inbox.teamId, teamId))
    .orderBy(desc(inbox.createdAt));
}

// Type for pending inbox items available for matching
export type PendingInboxItem = {
  id: string;
  amount: number | null;
  date: string | null;
  currency: string | null;
  createdAt: string;
};

// Get pending inbox items that are available for matching
export async function getPendingInboxForMatching(
  db: Database,
  params: {
    teamId: string;
    limit?: number;
  },
): Promise<PendingInboxItem[]> {
  const { teamId, limit = 100 } = params;

  return db
    .select({
      id: inbox.id,
      amount: inbox.amount,
      date: inbox.date,
      currency: inbox.currency,
      createdAt: inbox.createdAt,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, teamId),
        eq(inbox.status, "pending"), // Only pending items
        // Only items that haven't been matched yet
        sql`${inbox.transactionId} IS NULL`,
      ),
    )
    .orderBy(desc(inbox.createdAt)) // Newest first - prioritize recent items
    .limit(limit);
}

// Get a suggestion by inbox and transaction IDs
export async function getSuggestionByInboxAndTransaction(
  db: Database,
  params: {
    inboxId: string;
    transactionId: string;
    teamId: string;
  },
) {
  const { inboxId, transactionId, teamId } = params;

  const [result] = await db
    .select({
      id: transactionMatchSuggestions.id,
      inboxId: transactionMatchSuggestions.inboxId,
      transactionId: transactionMatchSuggestions.transactionId,
      status: transactionMatchSuggestions.status,
      confidenceScore: transactionMatchSuggestions.confidenceScore,
      matchType: transactionMatchSuggestions.matchType,
    })
    .from(transactionMatchSuggestions)
    .where(
      and(
        eq(transactionMatchSuggestions.inboxId, inboxId),
        eq(transactionMatchSuggestions.transactionId, transactionId),
        eq(transactionMatchSuggestions.teamId, teamId),
        eq(transactionMatchSuggestions.status, "pending"),
      ),
    )
    .limit(1);

  return result || null;
}

/**
 * The inbox statuses a document has reached once its extraction has finished.
 *
 * A row still being read has no invoice number yet, and one the pipeline gave
 * up on never will — neither can be decided on, and including them would only
 * produce a pile of "not extracted" that means "come back later".
 */
const EXTRACTED_INBOX_STATUSES = [
  "pending",
  "suggested_match",
  "no_match",
  "done",
] as const;

export type InboxDocumentForYukiDelivery = {
  id: string;
  filePath: string[] | null;
  contentType: string | null;
  invoiceNumber: string | null;
  type: "invoice" | "expense" | "other" | null;
  displayName: string | null;
  /** Context for a human only. Nothing in FF-1493 decides on a date... */
  date: string | null;
  /** ...or on an amount. */
  amount: number | null;
  currency: string | null;
  website: string | null;
};

/**
 * Every document of a team's inbox that the Yuki purchase decision has to rule
 * on (FF-1493).
 *
 * **There is no date window, and that is the point.** The previous version of
 * this query took a `from` and a `to` derived from Yuki's oldest outstanding
 * payment. A window is a way to miss a document: the FF-1448 spike's 120-day
 * check missed an OpenAI invoice from January that Yuki already held, and would
 * have delivered a duplicate. The archive is read whole (FF-1498) precisely so
 * nothing here has to be bounded by a date.
 *
 * Grouped siblings are **kept**, unlike before. Two documents sharing an
 * invoice number is rule 2, and it is a question for a person — which of these
 * is the invoice, and which is the billing statement? Midday's own grouping
 * already picks a primary by type, but that is a display heuristic, and letting
 * it decide here would deliver whichever it happened to prefer.
 *
 * Documents pulled *out of* Yuki are left out: they are in Yuki by definition,
 * and sending one back would be a duplicate with extra steps.
 */
export async function getInboxDocumentsForYukiDelivery(
  db: Database,
  params: { teamId: string },
): Promise<InboxDocumentForYukiDelivery[]> {
  return db
    .select({
      id: inbox.id,
      filePath: inbox.filePath,
      contentType: inbox.contentType,
      invoiceNumber: inbox.invoiceNumber,
      type: inbox.type,
      displayName: inbox.displayName,
      date: inbox.date,
      amount: inbox.amount,
      currency: inbox.currency,
      website: inbox.website,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        inArray(inbox.status, [...EXTRACTED_INBOX_STATUSES]),
        or(isNull(inbox.referenceId), notLike(inbox.referenceId, "yuki:%")),
      ),
    );
}
