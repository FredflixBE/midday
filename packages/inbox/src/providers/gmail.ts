// The two API clients this file calls, rather than the umbrella `googleapis`
// package, which generates one for every Google API and imports all of them.
// That cost 33 MB of the bundle and, through the source map the dev worker
// resolves stack frames against, 582 MB of heap per frame — enough to kill a
// warm executor mid-error. See FF-1487.
//
// `auth.OAuth2` comes from the client package on purpose: it is the same
// class the client's own `auth` option is typed against, so the two cannot
// drift onto different copies of google-auth-library.
import { auth, gmail, type gmail_v1 } from "@googleapis/gmail";
import { oauth2 } from "@googleapis/oauth2";
import type { Database } from "@midday/db/client";
import { updateInboxAccount } from "@midday/db/queries";
import { encrypt } from "@midday/encryption";
import { ensureFileExtension } from "@midday/utils";
import type { Credentials } from "google-auth-library";
import { decodeBase64Url } from "../attachments";
import { InboxAuthError, InboxSyncError } from "../errors";
import { generateDeterministicId } from "../generate-id";
import type {
  Attachment,
  EmailAttachment,
  ListMessagesOptions,
  OAuthProviderInterface,
  RevokeAccessResult,
  Tokens,
  UserInfo,
} from "./types";

/**
 * Token expiry buffer in milliseconds.
 * We refresh tokens 5 minutes before they expire to avoid edge cases
 * where a token expires mid-request.
 */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** The most ids `messages.list` returns in one page. */
const LIST_PAGE_SIZE = 500;

/** The 403 reasons that mean "slow down" rather than "not allowed". */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/**
 * Google API error structure
 */
interface GoogleApiError extends Error {
  code?: number | string;
  status?: number;
  errors?: { reason?: string }[];
  response?: {
    status?: number;
    data?: {
      error?: string | { code?: number; errors?: { reason?: string }[] };
      error_description?: string;
    };
  };
}

function statusOf(error: unknown): number | undefined {
  const googleError = error as GoogleApiError;
  if (typeof googleError?.status === "number") return googleError.status;
  if (typeof googleError?.code === "number") return googleError.code;
  return googleError?.response?.status;
}

function reasonOf(error: unknown): string | undefined {
  const googleError = error as GoogleApiError;
  const body = googleError?.response?.data?.error;
  const errors = typeof body === "object" ? body?.errors : googleError?.errors;
  return errors?.[0]?.reason;
}

export class GmailProvider implements OAuthProviderInterface {
  #oauth2Client: InstanceType<typeof auth.OAuth2>;
  #gmail: gmail_v1.Gmail | null = null;
  #accountId: string | null = null;
  #db: Database;
  #expiryDate: number | null = null;

  // Prevent concurrent refresh operations
  #refreshPromise: Promise<void> | null = null;

  #scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ];

  constructor(db: Database) {
    this.#db = db;

    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const redirectUri = process.env.GMAIL_REDIRECT_URI;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Missing required Gmail OAuth2 credentials: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set",
      );
    }

    this.#oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  setAccountId(accountId: string): void {
    this.#accountId = accountId;
  }

  async getAuthUrl(state?: string): Promise<string> {
    return this.#oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: this.#scopes,
      state: state ?? "gmail",
    });
  }

  async exchangeCodeForTokens(code: string): Promise<Tokens> {
    try {
      const { tokens } = await this.#oauth2Client.getToken(code);
      if (!tokens.access_token) {
        throw new Error("Failed to obtain access token.");
      }

      const validTokens: Tokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? undefined,
        expiry_date: tokens.expiry_date ?? undefined,
        scope: tokens.scope ?? undefined,
        token_type: tokens.token_type ?? undefined,
      };

      this.setTokens(validTokens);
      return validTokens;
    } catch (error: unknown) {
      console.error("Error exchanging code for tokens:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to exchange code for tokens: ${message}`);
    }
  }

  setTokens(tokens: Tokens): void {
    if (!tokens.access_token) {
      throw new Error("Access token is required");
    }

    // Track expiry date in memory for proactive refresh
    this.#expiryDate = tokens.expiry_date ?? null;

    const googleCredentials: Credentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
      token_type: tokens.token_type as Credentials["token_type"],
    };

    this.#oauth2Client.setCredentials(googleCredentials);
    this.#gmail = gmail({ version: "v1", auth: this.#oauth2Client });
  }

  /**
   * Checks if the token is expired or will expire within the buffer period.
   */
  #isTokenExpiredOrExpiring(): boolean {
    if (!this.#expiryDate) {
      // If we don't have expiry info, assume token might be expired
      // This is a safe default that triggers a refresh attempt
      return true;
    }

    const now = Date.now();
    const expiresWithBuffer = this.#expiryDate - TOKEN_EXPIRY_BUFFER_MS;

    return now >= expiresWithBuffer;
  }

  /**
   * Ensures we have a valid access token, refreshing if necessary.
   * This is called before making API calls.
   */
  async #ensureValidAccessToken(): Promise<void> {
    const credentials = this.#oauth2Client.credentials;

    if (!credentials.access_token) {
      throw new InboxAuthError({
        code: "token_invalid",
        provider: "gmail",
        message: "No access token available. Authentication required.",
        requiresReauth: true,
      });
    }

    // Check if token is expired or about to expire
    if (this.#isTokenExpiredOrExpiring()) {
      await this.#refreshTokensInternal();
    }
  }

  /**
   * Internal token refresh with concurrency protection.
   * Ensures only one refresh operation happens at a time.
   */
  async #refreshTokensInternal(): Promise<void> {
    // If a refresh is already in progress, wait for it
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    // Start a new refresh operation
    this.#refreshPromise = this.#doRefreshTokens();

    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = null;
    }
  }

  /**
   * Performs the actual token refresh.
   */
  async #doRefreshTokens(): Promise<void> {
    const credentials = this.#oauth2Client.credentials;

    if (!credentials.refresh_token) {
      throw new InboxAuthError({
        code: "refresh_token_invalid",
        provider: "gmail",
        message: "Refresh token is not available. Re-authentication required.",
        requiresReauth: true,
      });
    }

    try {
      const { credentials: newCredentials } =
        await this.#oauth2Client.refreshAccessToken();

      if (!newCredentials.access_token) {
        throw new InboxAuthError({
          code: "token_invalid",
          provider: "gmail",
          message: "Failed to refresh access token",
          requiresReauth: true,
        });
      }

      // Update expiry date in memory
      if (newCredentials.expiry_date) {
        this.#expiryDate = newCredentials.expiry_date;
      }

      // Persist tokens to database if we have an account ID
      if (this.#accountId) {
        await this.#persistTokensToDatabase(newCredentials);
      }

      console.log("Successfully refreshed Gmail access token", {
        accountId: this.#accountId,
        newExpiryDate: newCredentials.expiry_date
          ? new Date(newCredentials.expiry_date).toISOString()
          : "unknown",
      });
    } catch (error: unknown) {
      // Re-throw InboxAuthError as-is
      if (error instanceof InboxAuthError) {
        throw error;
      }

      const googleError = error as GoogleApiError;
      const statusCode = googleError.code ?? googleError.response?.status;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      console.error("Token refresh failed", {
        statusCode,
        errorMessage,
        accountId: this.#accountId,
      });

      // Check for specific Google OAuth error codes
      if (
        statusCode === 400 ||
        statusCode === 401 ||
        errorMessage.includes("invalid_grant")
      ) {
        throw new InboxAuthError({
          code: "refresh_token_expired",
          provider: "gmail",
          message:
            "Refresh token is invalid or expired. Re-authentication required.",
          requiresReauth: true,
          cause: error instanceof Error ? error : undefined,
        });
      }

      if (errorMessage.includes("invalid_request")) {
        throw new InboxAuthError({
          code: "token_invalid",
          provider: "gmail",
          message:
            "Invalid refresh token request. Check OAuth2 client configuration.",
          requiresReauth: true,
          cause: error instanceof Error ? error : undefined,
        });
      }

      throw new InboxAuthError({
        code: "token_invalid",
        provider: "gmail",
        message: `Token refresh failed: ${errorMessage}`,
        requiresReauth: false, // May be transient
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Persists refreshed tokens to the database.
   */
  async #persistTokensToDatabase(credentials: Credentials): Promise<void> {
    if (!this.#accountId) return;

    try {
      // Update refresh token if a new one was issued (token rotation)
      if (credentials.refresh_token) {
        await updateInboxAccount(this.#db, {
          id: this.#accountId,
          refreshToken: encrypt(credentials.refresh_token),
        });
      }

      // Always update access token and expiry
      if (credentials.access_token) {
        await updateInboxAccount(this.#db, {
          id: this.#accountId,
          accessToken: encrypt(credentials.access_token),
          expiryDate: credentials.expiry_date
            ? new Date(credentials.expiry_date).toISOString()
            : undefined,
        });
      }
    } catch (error) {
      console.error("Failed to persist tokens to database:", error);
      // Don't throw - the refresh itself succeeded, we just failed to persist
    }
  }

  /**
   * Public method for explicit token refresh (used by connector retry logic).
   */
  async refreshTokens(): Promise<void> {
    if (!this.#accountId) {
      throw new Error("Account ID is required for token refresh");
    }

    await this.#refreshTokensInternal();
  }

  /**
   * Google withdraws more than this token: revocation "removes all OAuth 2.0
   * scopes previously granted to a project", so every token the account holds
   * for this app stops working. Callers must not revoke an address that is
   * still connected.
   */
  async revokeAccess(refreshToken: string): Promise<RevokeAccessResult> {
    if (!refreshToken) return "already-revoked";

    try {
      await this.#oauth2Client.revokeToken(refreshToken);
      return "revoked";
    } catch (error: unknown) {
      // An expired or already revoked token has nothing left to withdraw.
      if ((error as GoogleApiError).response?.data?.error === "invalid_token") {
        return "already-revoked";
      }

      throw error;
    }
  }

  async getUserInfo(): Promise<UserInfo | undefined> {
    try {
      // Ensure token is valid before making API call
      await this.#ensureValidAccessToken();

      const oauth2Api = oauth2({
        auth: this.#oauth2Client,
        version: "v2",
      });

      const userInfoResponse = await oauth2Api.userinfo.get();
      const userInfo = userInfoResponse.data;

      return {
        id: userInfo.id ?? undefined,
        email: userInfo.email ?? undefined,
        name: userInfo.name ?? undefined,
      };
    } catch (error: unknown) {
      console.error("Error fetching user info:", error);
      return undefined;
    }
  }

  async listMessageIds(options: ListMessagesOptions): Promise<string[]> {
    const client = await this.#client();

    // Epoch seconds rather than a date: Gmail reads a date as midnight in
    // California, which would start the window up to nine hours off.
    const after = Math.floor(options.since.getTime() / 1000);
    const q = `-from:me has:attachment filename:pdf after:${after}`;

    const ids: string[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const { data } = await client.users.messages.list({
          userId: "me",
          q,
          maxResults: LIST_PAGE_SIZE,
          pageToken,
        });

        for (const message of data.messages ?? []) {
          if (message.id) ids.push(message.id);
        }

        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error: unknown) {
      throw this.#toInboxError(error, "Failed to list messages");
    }

    return ids;
  }

  async #client(): Promise<gmail_v1.Gmail> {
    if (!this.#gmail) {
      throw new Error("Gmail client not initialized. Set tokens first.");
    }

    // Proactively refresh token if expired or expiring soon
    await this.#ensureValidAccessToken();

    return this.#gmail;
  }

  async getMessageAttachments(messageIds: string[]): Promise<Attachment[]> {
    const client = await this.#client();

    try {
      const messages = await Promise.all(
        messageIds.map(async (id) => {
          try {
            const { data } = await client.users.messages.get({
              userId: "me",
              id,
              format: "full",
            });
            return data;
          } catch (error: unknown) {
            // Deleted since it was listed: there is nothing left to read.
            if (statusOf(error) === 404) return null;
            throw error;
          }
        }),
      );

      const attachments = await Promise.all(
        messages
          .filter((message): message is gmail_v1.Schema$Message =>
            Boolean(message),
          )
          .map((message) => this.#processMessageToAttachments(message)),
      );

      return attachments.flat();
    } catch (error: unknown) {
      throw this.#toInboxError(error, "Failed to fetch attachments");
    }
  }

  /**
   * Classify a failed Gmail call as an auth or a sync error. Which one decides
   * whether the account is marked disconnected, so a quota error must never
   * read as an auth error.
   */
  #toInboxError(
    error: unknown,
    context: string,
  ): InboxAuthError | InboxSyncError {
    if (error instanceof InboxAuthError || error instanceof InboxSyncError) {
      return error;
    }

    const statusCode = statusOf(error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const cause = error instanceof Error ? error : undefined;

    // Log the full error for debugging
    console.error("Gmail API error:", {
      statusCode,
      reason: reasonOf(error),
      errorMessage,
      accountId: this.#accountId,
      timestamp: new Date().toISOString(),
    });

    // Gmail answers a per-user quota breach with 403 as well as 429. It is
    // over in a second, and must not disconnect the account.
    if (
      statusCode === 429 ||
      (statusCode === 403 && RATE_LIMIT_REASONS.has(reasonOf(error) ?? ""))
    ) {
      return new InboxSyncError({
        code: "rate_limited",
        provider: "gmail",
        message: "Gmail API rate limit exceeded. Please try again later.",
        cause,
      });
    }

    // Use status codes for reliable detection, not message parsing
    // 401 = Unauthorized (token issues)
    if (statusCode === 401) {
      return new InboxAuthError({
        code: "token_expired",
        provider: "gmail",
        message: "Access token is invalid or expired. Authentication required.",
        requiresReauth: true,
        cause,
      });
    }

    // 403 = Forbidden (permission issues)
    if (statusCode === 403) {
      return new InboxAuthError({
        code: "forbidden",
        provider: "gmail",
        message: "Insufficient permissions.",
        requiresReauth: true,
        cause,
      });
    }

    // 400 = Bad request (could be token issues)
    if (statusCode === 400 && errorMessage.includes("invalid_grant")) {
      return new InboxAuthError({
        code: "refresh_token_expired",
        provider: "gmail",
        message:
          "Refresh token is invalid or expired. Re-authentication required.",
        requiresReauth: true,
        cause,
      });
    }

    return new InboxSyncError({
      code: "fetch_failed",
      provider: "gmail",
      message: `${context}: ${errorMessage}`,
      cause,
    });
  }

  async #processMessageToAttachments(
    message: gmail_v1.Schema$Message,
  ): Promise<Attachment[]> {
    if (!message.id || !message.payload?.parts) {
      console.warn(
        `Skipping message ${message.id} due to missing ID or parts.`,
      );
      return [];
    }

    // Find the 'From' header to extract sender details
    const fromHeader = message.payload?.headers?.find(
      (h) => h.name === "From",
    )?.value;
    let senderDomain: string | undefined;
    let senderEmail: string | undefined;

    if (fromHeader) {
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const email = emailMatch ? emailMatch[1] : fromHeader;
      senderEmail = email?.includes("@") ? email : undefined;
      const domain = email?.split("@")[1];

      // Extract root domain (remove subdomains)
      if (domain) {
        const domainParts = domain.split(".");
        const partsCount = domainParts.length;

        // Get the root domain (last two parts or just the domain if it's a simple domain)
        senderDomain =
          partsCount >= 2
            ? `${domainParts[partsCount - 2]}.${domainParts[partsCount - 1]}`
            : domain;
      }
    }

    // A failure here fails the batch: swallowing it would let the sync move
    // past a message whose invoice it never saw.
    const rawAttachments = await this.#fetchAttachments(
      message.id,
      message.payload.parts,
    );

    return rawAttachments.map((att) => {
      const filename = ensureFileExtension(att.filename, att.mimeType);
      const referenceId = generateDeterministicId(`${message.id}_${filename}`);

      return {
        id: referenceId,
        filename,
        mimeType: att.mimeType,
        size: att.size,
        data: decodeBase64Url(att.data),
        website: senderDomain,
        senderEmail: senderEmail,
        referenceId: referenceId,
      };
    });
  }

  async #fetchAttachments(
    messageId: string,
    parts: gmail_v1.Schema$MessagePart[],
  ): Promise<EmailAttachment[]> {
    const attachments: EmailAttachment[] = [];
    let attachmentsCount = 0;
    const maxAttachments = 5;

    if (!this.#gmail) return attachments;

    for (const part of parts) {
      if (attachmentsCount >= maxAttachments) {
        console.log(
          `Reached maximum attachment limit (${maxAttachments}) for message ${messageId}. Skipping further attachments.`,
        );
        break;
      }

      // Only process parts with PDF or octet-stream MIME types
      const mimeType = part.mimeType ?? "application/octet-stream";

      if (
        part.filename &&
        part.body?.attachmentId &&
        (mimeType === "application/pdf" ||
          mimeType === "application/octet-stream")
      ) {
        try {
          const attachmentResponse =
            await this.#gmail.users.messages.attachments.get({
              userId: "me",
              messageId: messageId,
              id: part.body.attachmentId,
            });

          if (attachmentResponse.data.data) {
            attachments.push({
              filename: part.filename,
              mimeType: mimeType,
              size: attachmentResponse.data.size ?? 0,
              data: attachmentResponse.data.data,
            });
            attachmentsCount++;
          }
        } catch (error: unknown) {
          // Only an attachment that no longer exists may be passed over.
          if (statusOf(error) !== 404) throw error;

          console.warn(
            `Attachment ${part.filename} of message ${messageId} no longer exists`,
          );
        }
      }

      if (part.parts) {
        const nestedAttachments = await this.#fetchAttachments(
          messageId,
          part.parts,
        );
        attachments.push(...nestedAttachments);
        attachmentsCount = attachments.length;
        if (attachmentsCount >= maxAttachments) {
          console.log(
            `Reached maximum attachment limit (${maxAttachments}) after processing nested parts for message ${messageId}.`,
          );
          break;
        }
      }
    }

    return attachments.slice(0, maxAttachments);
  }
}
