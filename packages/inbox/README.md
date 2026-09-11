# @midday/inbox

Email inbox integration package for syncing PDF attachments from Gmail and Outlook accounts.

## Overview

This package provides OAuth-based email provider integrations that:
- Connect user email accounts via OAuth 2.0
- Sync PDF attachments from incoming emails
- Handle token refresh and expiration automatically
- Provide structured error handling for robust sync operations

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     InboxConnector                          │
│  - Orchestrates provider selection                          │
│  - Handles token decryption/encryption                      │
│  - Manages retry logic with token refresh                   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│      GmailProvider      │     │     OutlookProvider     │
│  - Google OAuth2        │     │  - Microsoft OAuth2     │
│  - Gmail API v1         │     │  - Microsoft Graph API  │
│  - Proactive refresh    │     │  - Custom AuthProvider  │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Structured Errors                        │
│  - InboxAuthError (authentication/authorization)            │
│  - InboxSyncError (transient sync issues)                   │
└─────────────────────────────────────────────────────────────┘
```

## Usage

### Connecting an Account

```typescript
import { InboxConnector } from "@midday/inbox/connector";

const connector = new InboxConnector("gmail", db);

// Get OAuth URL for user to authorize
const authUrl = await connector.connect();

// After user authorizes, exchange code for account
const account = await connector.exchangeCodeForAccount({
  code: authorizationCode,
  teamId: "team_123",
});
```

### Syncing Attachments

A sync is two calls: list every message in the window, then read their
attachments a batch at a time. Listing has no cap, so a caller can move its
watermark once every batch is read and never before.

```typescript
const messageIds = await connector.listMessageIds({
  id: accountId,
  teamId: "team_123",
  since: new Date("2025-01-01T00:00:00Z"),
});

const attachments = await connector.getMessageAttachments({
  id: accountId,
  teamId: "team_123",
  messageIds: messageIds.slice(0, 20),
});

for (const attachment of attachments) {
  console.log(attachment.filename, attachment.size);
  // attachment.data contains the file buffer
}
```

`getMessageAttachments` throws rather than skip a message it could not read;
only a message deleted since it was listed is passed over.

In the jobs package, `sync-inbox-account` does this: pass it `since`
(YYYY-MM-DD) to backfill an account from that date.

## Error Handling

The package uses structured error classes for type-safe error handling.

### Error Types

#### InboxAuthError

Authentication and authorization errors. Check `requiresReauth` to determine if user action is needed.

```typescript
import { InboxAuthError, isInboxAuthError } from "@midday/inbox/errors";

try {
  await connector.getMessageAttachments(options);
} catch (error) {
  if (isInboxAuthError(error)) {
    console.log(error.code);          // "token_expired" | "refresh_token_invalid" | ...
    console.log(error.provider);      // "gmail" | "outlook"
    console.log(error.requiresReauth); // true = user must reconnect
    
    if (error.requiresReauth) {
      // Mark account as disconnected, prompt user to reconnect
    } else {
      // Transient error, retry may succeed
    }
  }
}
```

**Error Codes:**
| Code | Description | Requires Reauth |
|------|-------------|-----------------|
| `token_expired` | Access token expired | Usually yes |
| `token_invalid` | Access token is invalid | Yes |
| `refresh_token_expired` | Refresh token expired | Yes |
| `refresh_token_invalid` | Refresh token missing/invalid | Yes |
| `unauthorized` | General 401 error | Yes |
| `forbidden` | Permission denied (403) | Yes |
| `consent_required` | User must re-consent (Outlook) | Yes |
| `mfa_required` | MFA challenge required (Outlook) | Yes |

#### InboxSyncError

Non-authentication sync errors. These are typically transient.

```typescript
import { InboxSyncError } from "@midday/inbox/errors";

if (error instanceof InboxSyncError) {
  console.log(error.code);        // "fetch_failed" | "rate_limited" | ...
  console.log(error.isRetryable()); // true for network/rate limit errors
}
```

**Error Codes:**
| Code | Description | Retryable |
|------|-------------|-----------|
| `fetch_failed` | General fetch failure | Maybe |
| `rate_limited` | API rate limit hit | Yes |
| `network_error` | Network connectivity issue | Yes |
| `provider_error` | Provider-specific error | Maybe |

### Type Guards and Assertions

```typescript
import {
  isInboxAuthError,
  isInboxSyncError,
  assertInboxAuthError,
  assertInboxSyncError,
} from "@midday/inbox/errors";

// Type guards (return boolean)
if (isInboxAuthError(error)) {
  // error is InboxAuthError
}

// Assertions (narrow type, throw if wrong)
assertInboxAuthError(error);
// error is now InboxAuthError
```

## Token Management

Both providers implement proactive token refresh:

1. **5-minute buffer**: Tokens are refreshed 5 minutes before expiration
2. **Concurrency protection**: Only one refresh operation runs at a time
3. **Automatic persistence**: Refreshed tokens are saved to the database
4. **Token rotation support**: New refresh tokens (if issued) are stored

```typescript
// Providers handle this internally, but you can force a refresh:
await provider.refreshTokens();
```

## Exports

```typescript
// Main connector
import { InboxConnector } from "@midday/inbox/connector";

// Error classes and utilities
import {
  InboxAuthError,
  InboxSyncError,
  isInboxAuthError,
  isInboxSyncError,
  assertInboxAuthError,
  assertInboxSyncError,
} from "@midday/inbox/errors";

// Utility functions
import { isAuthenticationError } from "@midday/inbox/utils";
```

## Environment Variables

### Gmail
- `GMAIL_CLIENT_ID` - Google OAuth client ID
- `GMAIL_CLIENT_SECRET` - Google OAuth client secret
- `GMAIL_REDIRECT_URI` - OAuth callback URL

### Outlook
- `OUTLOOK_CLIENT_ID` - Microsoft OAuth client ID
- `OUTLOOK_CLIENT_SECRET` - Microsoft OAuth client secret
- `OUTLOOK_REDIRECT_URI` - OAuth callback URL
