import {
  createSlackWebClient,
  sendSlackMatchNotification,
} from "@midday/app-store/slack/server";
import type { Database } from "@midday/db/client";
import {
  getAppByAppId,
  getPlatformIdentityById,
  listDueProviderNotificationBatches,
  listPlatformIdentitiesForTeam,
  markProviderNotificationBatchSent,
  queueProviderNotificationBatch,
  shouldSendNotification,
  updatePlatformIdentityMetadata,
} from "@midday/db/queries";

export type ProviderNotificationType =
  | "transaction"
  | "match"
  | "invoice_paid"
  | "invoice_overdue"
  | "recurring_invoice_upcoming";

export type TransactionPayload = {
  transactions: Array<{
    id: string;
    name: string;
    amount: number;
    currency: string;
    date: string;
  }>;
};

export type MatchPayload = {
  inboxId: string;
  transactionId: string;
  documentName: string;
  documentAmount: number;
  documentCurrency: string;
  documentDate?: string;
  transactionName: string;
  transactionAmount: number;
  transactionCurrency: string;
  transactionDate?: string;
  confidenceScore: number;
  matchType: "auto_matched" | "high_confidence" | "suggested";
};

export type InvoicePaidPayload = {
  invoiceId: string;
  invoiceNumber: string;
  customerName?: string;
  paidAt?: string;
};

export type InvoiceOverduePayload = {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
};

export type RecurringInvoiceUpcomingPayload = {
  invoices: Array<{
    recurringId: string;
    customerName?: string;
    amount?: number;
    currency?: string;
    scheduledAt: string;
    frequency?: string | null;
  }>;
  count: number;
};

type ProviderPayload = {
  transaction: TransactionPayload;
  match: MatchPayload;
  invoice_paid: InvoicePaidPayload;
  invoice_overdue: InvoiceOverduePayload;
  recurring_invoice_upcoming: RecurringInvoiceUpcomingPayload;
};

type AppConfig = {
  id: string;
  appId: string;
  teamId: string;
  config?: {
    access_token?: string;
    channel_id?: string;
    [key: string]: unknown;
  };
  settings?: Array<{ id: string; value: boolean | string | number }>;
};

export type NotificationContext = {
  eventType: ProviderNotificationType;
  teamId: string;
  userId: string;
  entityType: string;
  entityIds: string[];
  summary: string;
  sourcePlatform: "slack";
  sourceMessageId?: string;
  suggestedPrompts: string[];
  sentAt: string;
};

export type SendToProvidersOptions = {
  inboxMeta?: {
    source?: string;
    sourceMetadata?: {
      channelId?: string;
      threadTs?: string;
      messageTs?: string;
      phoneNumber?: string;
      externalUserId?: string;
    };
  };
};

const BATCH_WINDOWS_MS: Record<
  Exclude<ProviderNotificationType, "match">,
  number
> = {
  transaction: 10 * 60 * 1000,
  invoice_paid: 10 * 60 * 1000,
  invoice_overdue: 30 * 60 * 1000,
  recurring_invoice_upcoming: 60 * 60 * 1000,
};

const USER_NOTIFICATION_MAP: Record<
  Exclude<ProviderNotificationType, "match">,
  string
> = {
  transaction: "transactions_created",
  invoice_paid: "invoice_paid",
  invoice_overdue: "invoice_overdue",
  recurring_invoice_upcoming: "recurring_invoice_upcoming",
};

const APP_SETTING_MAP: Record<ProviderNotificationType, string> = {
  transaction: "transactions",
  match: "matches",
  invoice_paid: "invoices",
  invoice_overdue: "invoices",
  recurring_invoice_upcoming: "invoices",
};

export async function sendToProviders<T extends ProviderNotificationType>(
  db: Database,
  teamId: string,
  type: T,
  payload: ProviderPayload[T],
  options?: SendToProvidersOptions,
): Promise<void> {
  if (type === "match") {
    await sendImmediateMatchNotifications(
      db,
      teamId,
      payload as MatchPayload,
      options,
    );
    return;
  }

  await queueTeamWideNotification(
    db,
    teamId,
    type as Exclude<ProviderNotificationType, "match">,
    payload as
      | TransactionPayload
      | InvoicePaidPayload
      | InvoiceOverduePayload
      | RecurringInvoiceUpcomingPayload,
  );
}

export async function flushDueActivityNotificationBatches(db: Database) {
  const batches = await listDueProviderNotificationBatches(db, 100);

  for (const batch of batches) {
    const identity = await getPlatformIdentityById(
      db,
      batch.platformIdentityId,
    );

    if (!identity) {
      await markProviderNotificationBatchSent(db, { id: batch.id });
      continue;
    }

    // Batches queued for providers this fork no longer ships are marked sent
    // so they stop being retried.
    if (batch.provider !== "slack") {
      await markProviderNotificationBatchSent(db, { id: batch.id });
      continue;
    }

    const app = await getAppConfig(db, batch.provider, batch.teamId);
    if (
      !app ||
      !isSettingEnabled(app, batch.eventFamily as ProviderNotificationType)
    ) {
      await markProviderNotificationBatchSent(db, { id: batch.id });
      continue;
    }

    const userNotificationType =
      USER_NOTIFICATION_MAP[
        batch.eventFamily as Exclude<ProviderNotificationType, "match">
      ];

    const userEnabled = await shouldSendNotification(
      db,
      batch.userId,
      batch.teamId,
      userNotificationType,
      "in_app",
    );

    if (!userEnabled) {
      await markProviderNotificationBatchSent(db, { id: batch.id });
      continue;
    }

    const summary = buildBatchSummary(
      batch.eventFamily as Exclude<ProviderNotificationType, "match">,
      (batch.payload as { entries?: Array<Record<string, unknown>> } | null)
        ?.entries ?? [],
      {
        teamId: batch.teamId,
        userId: batch.userId,
        provider: batch.provider,
      },
    );

    if (!summary) {
      await markProviderNotificationBatchSent(db, { id: batch.id });
      continue;
    }

    const entries =
      (batch.payload as { entries?: Array<Record<string, unknown>> } | null)
        ?.entries ?? [];

    const sent = await sendSummaryToIdentity(
      app,
      identity,
      summary.text,
      batch.eventFamily,
      entries,
    );

    if (!sent) {
      await markProviderNotificationBatchSent(db, { id: batch.id });
      continue;
    }

    await updatePlatformIdentityMetadata(db, {
      id: identity.id,
      metadata: {
        lastNotificationContext: summary.context,
        lastNotificationSentAt: summary.context.sentAt,
      },
    });

    await markProviderNotificationBatchSent(db, {
      id: batch.id,
      notificationContext: summary.context,
    });
  }
}

export function formatNotificationContextForPrompt(
  context: NotificationContext | null | undefined,
) {
  if (!context) {
    return "";
  }

  const prompts =
    context.suggestedPrompts.length > 0
      ? ` Suggested follow-ups: ${context.suggestedPrompts.join(", ")}.`
      : "";

  return `The user's latest bot notification context is: ${context.summary}.${prompts}`;
}

async function queueTeamWideNotification(
  db: Database,
  teamId: string,
  type: Exclude<ProviderNotificationType, "match">,
  payload:
    | TransactionPayload
    | InvoicePaidPayload
    | InvoiceOverduePayload
    | RecurringInvoiceUpcomingPayload,
) {
  for (const provider of ["slack"] as const) {
    const app = await getAppConfig(db, provider, teamId);

    if (!app || !isSettingEnabled(app, type)) {
      continue;
    }

    const identities = await listPlatformIdentitiesForTeam(db, {
      provider,
      teamId,
    });

    for (const identity of identities) {
      const enabled = await shouldSendNotification(
        db,
        identity.userId,
        teamId,
        USER_NOTIFICATION_MAP[type],
        "in_app",
      );

      if (!enabled) {
        continue;
      }

      const windowEndsAt = new Date(
        Date.now() + BATCH_WINDOWS_MS[type],
      ).toISOString();

      await queueProviderNotificationBatch(db, {
        batchKey: `${identity.id}:${type}`,
        platformIdentityId: identity.id,
        teamId,
        userId: identity.userId,
        provider,
        eventFamily: type,
        entry: createBatchEntry(type, payload),
        notificationContext: {
          eventType: type,
          teamId,
          userId: identity.userId,
        },
        windowEndsAt,
      });
    }
  }
}

async function sendImmediateMatchNotifications(
  db: Database,
  teamId: string,
  payload: MatchPayload,
  options?: SendToProvidersOptions,
) {
  const source = options?.inboxMeta?.source;

  if (source === "slack") {
    const slackApp = await getAppConfig(db, "slack", teamId);
    const accessToken = slackApp?.config?.access_token;
    const channelId = options?.inboxMeta?.sourceMetadata?.channelId;

    if (accessToken && channelId) {
      await sendSlackMatchNotification({
        teamId,
        inboxId: payload.inboxId,
        transactionId: payload.transactionId,
        documentName: payload.documentName,
        documentAmount: payload.documentAmount,
        documentCurrency: payload.documentCurrency,
        documentDate: payload.documentDate,
        transactionName: payload.transactionName,
        transactionAmount: payload.transactionAmount,
        transactionCurrency: payload.transactionCurrency,
        transactionDate: payload.transactionDate,
        matchType: payload.matchType,
        slackChannelId: channelId,
        slackThreadTs:
          options?.inboxMeta?.sourceMetadata?.threadTs ||
          options?.inboxMeta?.sourceMetadata?.messageTs,
      });
      return;
    }
  }
}

async function sendSummaryToIdentity(
  app: AppConfig,
  identity: Awaited<ReturnType<typeof getPlatformIdentityById>>,
  text: string,
  eventFamily?: string,
  entries?: Array<Record<string, unknown>>,
) {
  if (!identity) {
    return false;
  }

  switch (identity.provider) {
    case "slack": {
      const accessToken = app.config?.access_token;
      if (!accessToken) {
        return false;
      }

      const client = createSlackWebClient({ token: accessToken });
      const result = await client.conversations.open({
        users: identity.externalUserId,
      });
      const channelId = result.channel?.id;

      if (!channelId) {
        return false;
      }

      await client.chat.postMessage({
        channel: channelId,
        text,
      });
      return true;
    }
    default:
      return false;
  }
}

export function buildBatchSummary(
  type: Exclude<ProviderNotificationType, "match">,
  entries: Array<Record<string, unknown>>,
  params: {
    teamId: string;
    userId: string;
    provider: "slack";
  },
) {
  const sentAt = new Date().toISOString();

  if (type === "transaction") {
    const transactions = entries.flatMap(
      (entry) =>
        (entry.transactions as
          | Array<{
              id: string;
              name: string;
              amount: number;
              currency: string;
              date: string;
            }>
          | undefined) ?? [],
    );

    if (transactions.length === 0) {
      return null;
    }

    const summary = `${transactions.length} new transaction${transactions.length === 1 ? "" : "s"}. Reply "show me them" and I can help review them.`;

    return {
      text: summary,
      context: {
        eventType: type,
        teamId: params.teamId,
        userId: params.userId,
        entityType: "transaction",
        entityIds: transactions.map((transaction) => transaction.id),
        summary,
        sourcePlatform: params.provider,
        suggestedPrompts: [
          "Show me them",
          "Which ones need receipts?",
          "Summarize the largest ones",
        ],
        sentAt,
      } satisfies NotificationContext,
    };
  }

  if (type === "invoice_paid") {
    const invoices = entries as Array<InvoicePaidPayload>;
    if (invoices.length === 0) {
      return null;
    }

    const invoiceLabels = invoices
      .slice(0, 3)
      .map((invoice) => invoice.invoiceNumber)
      .join(", ");
    const summary = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} ${invoices.length === 1 ? "was" : "were"} paid${invoiceLabels ? ` (${invoiceLabels})` : ""}. Reply "show me them" to review the details.`;

    return {
      text: summary,
      context: {
        eventType: type,
        teamId: params.teamId,
        userId: params.userId,
        entityType: "invoice",
        entityIds: invoices.map((invoice) => invoice.invoiceId),
        summary,
        sourcePlatform: params.provider,
        suggestedPrompts: [
          "Show me them",
          "What's still unpaid?",
          "Summarize the cash impact",
        ],
        sentAt,
      } satisfies NotificationContext,
    };
  }

  if (type === "invoice_overdue") {
    const invoices = entries as Array<InvoiceOverduePayload>;
    if (invoices.length === 0) {
      return null;
    }

    const summary = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} ${invoices.length === 1 ? "is" : "are"} overdue. Reply "show me them" and I can help you follow up.`;

    return {
      text: summary,
      context: {
        eventType: type,
        teamId: params.teamId,
        userId: params.userId,
        entityType: "invoice",
        entityIds: invoices.map((invoice) => invoice.invoiceId),
        summary,
        sourcePlatform: params.provider,
        suggestedPrompts: [
          "Show me them",
          "Draft a reminder",
          "Who is most overdue?",
        ],
        sentAt,
      } satisfies NotificationContext,
    };
  }

  const invoices = entries.flatMap(
    (entry) =>
      (entry.invoices as
        | Array<{
            recurringId: string;
            customerName?: string;
            amount?: number;
            currency?: string;
            scheduledAt: string;
            frequency?: string | null;
          }>
        | undefined) ?? [],
  );

  if (invoices.length === 0) {
    return null;
  }

  const summary = `${invoices.length} recurring invoice${invoices.length === 1 ? "" : "s"} ${invoices.length === 1 ? "is" : "are"} coming up soon. Reply "show me them" to review what is scheduled.`;

  return {
    text: summary,
    context: {
      eventType: type,
      teamId: params.teamId,
      userId: params.userId,
      entityType: "recurring_invoice",
      entityIds: invoices.map((invoice) => invoice.recurringId),
      summary,
      sourcePlatform: params.provider,
      suggestedPrompts: [
        "Show me them",
        "Which customers are affected?",
        "What is due soonest?",
      ],
      sentAt,
    } satisfies NotificationContext,
  };
}

function createBatchEntry(
  type: Exclude<ProviderNotificationType, "match">,
  payload:
    | TransactionPayload
    | InvoicePaidPayload
    | InvoiceOverduePayload
    | RecurringInvoiceUpcomingPayload,
) {
  switch (type) {
    case "transaction":
      return payload as TransactionPayload;
    case "invoice_paid":
      return payload as InvoicePaidPayload;
    case "invoice_overdue":
      return payload as InvoiceOverduePayload;
    case "recurring_invoice_upcoming":
      return payload as RecurringInvoiceUpcomingPayload;
  }
}

function isSettingEnabled(
  app: AppConfig,
  type: ProviderNotificationType,
): boolean {
  const settings = app.settings || [];
  const setting = settings.find((item) => item.id === APP_SETTING_MAP[type]);
  return setting?.value !== false;
}

async function getAppConfig(
  db: Database,
  appId: "slack",
  teamId: string,
): Promise<AppConfig | null> {
  const app = await getAppByAppId(db, { appId, teamId });
  if (!app) {
    return null;
  }

  return {
    id: app.id,
    appId: app.appId,
    teamId: app.teamId ?? teamId,
    config: app.config as AppConfig["config"],
    settings: app.settings as AppConfig["settings"],
  };
}
