import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as gmailModule from "@googleapis/gmail";
import { InboxSyncError } from "../errors";
import { GmailProvider } from "./gmail";
import type { Attachment } from "./types";

// Google's API client is the only thing faked: a mailbox held in memory,
// answering the three calls a sync makes the way the Gmail API does — newest
// first, at most 500 ids a page, and `after:` read as epoch seconds.

process.env.GMAIL_CLIENT_ID ??= "test-gmail-client";
process.env.GMAIL_CLIENT_SECRET ??= "test-gmail-secret";

type FakeMessage = {
  id: string;
  receivedAt: Date;
  from?: string;
  attachments: { filename: string; mimeType?: string; content: string }[];
};

let mailbox: FakeMessage[] = [];
let queries: string[] = [];
// A message id mapped to the error the API answers with when it is fetched.
let failures: Record<string, unknown> = {};

function apiError(status: number, reason?: string) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    status,
    response: {
      status,
      data: { error: { code: status, errors: reason ? [{ reason }] : [] } },
    },
  });
}

function base64Url(content: string) {
  return Buffer.from(content).toString("base64url");
}

const fakeClient = {
  users: {
    messages: {
      list: async (params: {
        q: string;
        maxResults?: number;
        pageToken?: string;
      }) => {
        queries.push(params.q);
        const after = Number(params.q.match(/after:(\d+)/)?.[1] ?? 0);
        const matches = mailbox
          .filter((m) => m.receivedAt.getTime() / 1000 > after)
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        const pageSize = Math.min(params.maxResults ?? 100, 500);
        const offset = Number(params.pageToken ?? 0);
        const page = matches.slice(offset, offset + pageSize);
        const next = offset + pageSize;

        return {
          data: {
            messages: page.length
              ? page.map((m) => ({ id: m.id, threadId: m.id }))
              : undefined,
            nextPageToken: next < matches.length ? String(next) : undefined,
          },
        };
      },
      get: async (params: { id: string }) => {
        if (params.id in failures) throw failures[params.id];
        const message = mailbox.find((m) => m.id === params.id);
        if (!message) throw apiError(404, "notFound");

        return {
          data: {
            id: message.id,
            internalDate: String(message.receivedAt.getTime()),
            payload: {
              headers: message.from
                ? [{ name: "From", value: message.from }]
                : [],
              parts: [
                { mimeType: "text/plain", body: { size: 10 } },
                ...message.attachments.map((attachment, index) => ({
                  filename: attachment.filename,
                  mimeType: attachment.mimeType ?? "application/pdf",
                  body: { attachmentId: `${message.id}-${index}` },
                })),
              ],
            },
          },
        };
      },
      attachments: {
        get: async (params: { messageId: string; id: string }) => {
          const message = mailbox.find((m) => m.id === params.messageId);
          const index = Number(params.id.split("-").at(-1));
          const attachment = message?.attachments[index];
          if (!attachment) throw apiError(404, "notFound");

          return {
            data: {
              size: attachment.content.length,
              data: base64Url(attachment.content),
            },
          };
        },
      },
    },
  },
};

class FakeOAuth2 {
  credentials: Record<string, unknown> = {};
  setCredentials(credentials: Record<string, unknown>) {
    this.credentials = credentials;
  }
}

mock.module("@googleapis/gmail", () => ({
  ...gmailModule,
  auth: { ...gmailModule.auth, OAuth2: FakeOAuth2 },
  gmail: () => fakeClient,
}));

function connectedProvider() {
  const provider = new GmailProvider({} as never);
  provider.setTokens({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expiry_date: Date.now() + 60 * 60 * 1000,
  });
  return provider;
}

function invoiceEmail(id: string, receivedAt: string): FakeMessage {
  return {
    id,
    receivedAt: new Date(receivedAt),
    from: "Billing <billing@mail.vendor.example>",
    attachments: [{ filename: `${id}.pdf`, content: `%PDF ${id}` }],
  };
}

beforeEach(() => {
  mailbox = [];
  queries = [];
  failures = {};
});

describe("listing the messages to sync", () => {
  test("returns every match since the date, however many there are", async () => {
    const since = new Date("2025-10-01T00:00:00Z");
    // 1,203 invoices after the date, spread over three pages, and one before.
    for (let i = 0; i < 1203; i++) {
      mailbox.push(
        invoiceEmail(
          `m${i}`,
          new Date(since.getTime() + (i + 1) * 3600_000).toISOString(),
        ),
      );
    }
    mailbox.push(invoiceEmail("too-old", "2025-09-30T23:00:00Z"));

    const ids = await connectedProvider().listMessageIds({ since });

    expect(ids).toHaveLength(1203);
    expect(new Set(ids).size).toBe(1203);
    expect(ids).not.toContain("too-old");
  });

  test("keeps the search to PDFs that someone else sent", async () => {
    await connectedProvider().listMessageIds({
      since: new Date("2025-10-01T00:00:00Z"),
    });

    expect(queries).toEqual([
      "-from:me has:attachment filename:pdf after:1759276800",
    ]);
  });
});

describe("reading the attachments of listed messages", () => {
  test("returns each PDF with its sender and the id earlier syncs stored it under", async () => {
    mailbox.push(invoiceEmail("m1", "2026-01-15T09:00:00Z"));

    const [attachment, ...rest] =
      await connectedProvider().getMessageAttachments(["m1"]);

    expect(rest).toEqual([]);
    expect(attachment).toMatchObject({
      filename: "m1.pdf",
      mimeType: "application/pdf",
      website: "vendor.example",
      senderEmail: "billing@mail.vendor.example",
      // sha256("m1_m1.pdf"): what the dedup against existing inbox rows keys on.
      referenceId:
        "407b44dcb584cff4aaa71a961d5929ad48725802888d30f59b9def9c0f6d672b",
    });
    expect(attachment?.data.toString()).toBe("%PDF m1");
  });

  test("passes over a message deleted since it was listed", async () => {
    mailbox.push(invoiceEmail("kept", "2026-01-15T09:00:00Z"));

    const attachments = await connectedProvider().getMessageAttachments([
      "deleted",
      "kept",
    ]);

    expect(attachments.map((a: Attachment) => a.filename)).toEqual([
      "kept.pdf",
    ]);
  });

  test("fails rather than skip a message it could not read", async () => {
    mailbox.push(invoiceEmail("m1", "2026-01-15T09:00:00Z"));
    mailbox.push(invoiceEmail("m2", "2026-01-15T10:00:00Z"));
    failures.m2 = apiError(500);

    const read = connectedProvider().getMessageAttachments(["m1", "m2"]);

    await expect(read).rejects.toBeInstanceOf(InboxSyncError);
  });

  test("treats Gmail's per-user quota as a rate limit, not lost access", async () => {
    mailbox.push(invoiceEmail("m1", "2026-01-15T09:00:00Z"));
    failures.m1 = apiError(403, "userRateLimitExceeded");

    const read = connectedProvider().getMessageAttachments(["m1"]);

    await expect(read).rejects.toMatchObject({
      name: "InboxSyncError",
      code: "rate_limited",
    });
  });
});
