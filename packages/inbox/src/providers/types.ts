export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  data: string; // Base64 encoded data
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  referenceId: string;
  data: Buffer;
  website?: string;
  senderEmail?: string;
}

export interface Account {
  id: string;
  provider: OAuthProvider;
  external_id: string;
}

export interface ListMessagesOptions {
  /** The start of the window. Mail received before it is not listed. */
  since: Date;
}

/** Identifies the inbox account a connector call reads from. */
export interface AccountRef {
  id: string;
  teamId: string;
}

export abstract class Connector {
  abstract connect(state?: string): Promise<string>;
  abstract exchangeCodeForAccount(
    params: ExchangeCodeForAccountParams,
  ): Promise<Account | null>;
  abstract listMessageIds(
    options: AccountRef & ListMessagesOptions,
  ): Promise<string[]>;
  abstract getMessageAttachments(
    options: AccountRef & { messageIds: string[] },
  ): Promise<Attachment[]>;
}

export interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string;
}

export interface ExchangeCodeForAccountParams {
  code: string;
  teamId: string;
}

export interface UserInfo {
  email?: string;
  id?: string;
  name?: string;
}

export type OAuthProvider = "gmail" | "outlook";

// Outlook-specific types
export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export interface OutlookMessage {
  id: string;
  from?: {
    emailAddress?: {
      address?: string;
    };
  };
  hasAttachments?: boolean;
}

export interface OutlookAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string;
  "@odata.type"?: string;
}

export interface OAuthProviderInterface {
  /**
   * Generates the authorization URL for the user to grant permission.
   * @param state - Optional custom state parameter for OAuth flow.
   */
  getAuthUrl(state?: string): Promise<string>;

  /**
   * Exchanges the authorization code received from the callback for access and refresh tokens.
   * @param code - The authorization code.
   */
  exchangeCodeForTokens(code: string): Promise<Tokens>;

  /**
   * Sets the credentials (tokens) for the OAuth client.
   * Required before making API calls.
   * @param tokens - The tokens obtained from the authorization flow.
   */
  setTokens(tokens: Tokens): void;

  /**
   * Lists every message received since `options.since` that may carry an
   * invoice — one with a PDF attached that the account did not send itself —
   * newest first. There is no cap: a sync that stopped short would move its
   * watermark past mail it never read.
   */
  listMessageIds(options: ListMessagesOptions): Promise<string[]>;

  /**
   * Fetches the PDF attachments of these messages. A message deleted since it
   * was listed is passed over; any other failure throws, rather than let the
   * caller count a message as read when it was not.
   */
  getMessageAttachments(messageIds: string[]): Promise<Attachment[]>;

  /**
   * Fetches user info from the provider.
   */
  getUserInfo(): Promise<UserInfo | undefined>;

  /**
   * Sets the account ID for the provider.
   * @param accountId - The account ID.
   */
  setAccountId(accountId: string): void;

  /**
   * Explicitly refreshes the access token using the refresh token.
   */
  refreshTokens(): Promise<void>;

  /**
   * Withdraws the access this refresh token grants, at the provider.
   * @param refreshToken - The decrypted refresh token.
   */
  revokeAccess(refreshToken: string): Promise<RevokeAccessResult>;
}

/**
 * What became of a mailbox's access when it was disconnected:
 * - `revoked`: the provider withdrew it.
 * - `already-revoked`: the provider no longer recognised the token.
 * - `unsupported`: the provider gives an app no way to revoke its own access.
 * - `still-connected`: the address is connected again, so it was left alone.
 */
export type RevokeAccessResult =
  | "revoked"
  | "already-revoked"
  | "unsupported"
  | "still-connected";
