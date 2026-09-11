import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as graphModule from "@microsoft/microsoft-graph-client";
import { InboxSyncError } from "../errors";
import { OutlookProvider } from "./outlook";
import type { Attachment } from "./types";

// Microsoft Graph's client is the only thing faked: a mailbox held in memory,
// answering the requests a sync makes the way Graph does — newest first, a
// page at most `$top` long, and the rest behind an `@odata.nextLink`.

process.env.OUTLOOK_CLIENT_ID ??= "test-outlook-client";
process.env.OUTLOOK_CLIENT_SECRET ??= "test-outlook-secret";
process.env.OUTLOOK_REDIRECT_URI ??= "https://midday.test/outlook";

const OWN_ADDRESS = "finance@company.example";

type FakeMessage = {
  id: string;
  receivedAt: Date;
  from: string;
  attachments: { name: string; contentType?: string; content: string }[];
};

let mailbox: FakeMessage[] = [];
// A message id mapped to the error Graph answers with when it is fetched.
let failures: Record<string, unknown> = {};

function graphError(statusCode: number, code: string) {
  return Object.assign(new Error(code), { statusCode, code });
}

function listPage(since: Date, top: number, offset: number) {
  const matches = mailbox
    .filter((m) => m.receivedAt >= since && m.attachments.length > 0)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const page = matches.slice(offset, offset + top);
  const next = offset + top;

  return {
    value: page.map((m) => ({
      id: m.id,
      from: { emailAddress: { address: m.from } },
      hasAttachments: true,
    })),
    "@odata.nextLink":
      next < matches.length
        ? `https://graph.test/next?since=${since.toISOString()}&top=${top}&offset=${next}`
        : undefined,
  };
}

function request(path: string) {
  const query: { filter?: string; top?: number } = {};

  const builder = {
    filter(filter: string) {
      query.filter = filter;
      return builder;
    },
    select() {
      return builder;
    },
    orderby() {
      return builder;
    },
    top(top: number) {
      query.top = top;
      return builder;
    },
    async get() {
      if (path === "/me") return { id: "me", mail: OWN_ADDRESS };

      if (path === "/me/messages") {
        const since = query.filter?.match(/receivedDateTime ge (\S+)/)?.[1];
        return listPage(new Date(since!), Math.min(query.top ?? 10, 1000), 0);
      }

      if (path.startsWith("https://graph.test/next")) {
        const params = new URL(path).searchParams;
        return listPage(
          new Date(params.get("since")!),
          Number(params.get("top")),
          Number(params.get("offset")),
        );
      }

      const [, id, , attachmentId] =
        path.match(/^\/me\/messages\/([^/]+)(\/attachments(?:\/(.+))?)?$/) ??
        [];
      if (id && id in failures) throw failures[id];
      const message = mailbox.find((m) => m.id === id);
      if (!message) throw graphError(404, "ErrorItemNotFound");

      if (!path.includes("/attachments")) {
        return { id, from: { emailAddress: { address: message.from } } };
      }

      if (attachmentId === undefined) {
        return {
          value: message.attachments.map((attachment, index) => ({
            id: String(index),
            name: attachment.name,
            contentType: attachment.contentType ?? "application/pdf",
            size: attachment.content.length,
            "@odata.type": "#microsoft.graph.fileAttachment",
          })),
        };
      }

      const attachment = message.attachments[Number(attachmentId)];
      return {
        contentBytes: Buffer.from(attachment!.content).toString("base64"),
      };
    },
  };

  return builder;
}

mock.module("@microsoft/microsoft-graph-client", () => ({
  ...graphModule,
  Client: { initWithMiddleware: () => ({ api: request }) },
}));

function connectedProvider() {
  const provider = new OutlookProvider({} as never);
  provider.setTokens({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expiry_date: Date.now() + 60 * 60 * 1000,
  });
  return provider;
}

function invoiceEmail(
  id: string,
  receivedAt: string,
  from = "billing@mail.vendor.example",
): FakeMessage {
  return {
    id,
    receivedAt: new Date(receivedAt),
    from,
    attachments: [{ name: `${id}.pdf`, content: `%PDF ${id}` }],
  };
}

beforeEach(() => {
  mailbox = [];
  failures = {};
});

describe("listing the messages to sync", () => {
  test("returns every match since the date that someone else sent", async () => {
    const since = new Date("2025-10-01T00:00:00Z");
    for (let i = 0; i < 1203; i++) {
      mailbox.push(
        invoiceEmail(
          `o${i}`,
          new Date(since.getTime() + (i + 1) * 3600_000).toISOString(),
        ),
      );
    }
    mailbox.push(invoiceEmail("too-old", "2025-09-30T23:00:00Z"));
    mailbox.push(invoiceEmail("own", "2026-01-15T09:00:00Z", OWN_ADDRESS));

    const ids = await connectedProvider().listMessageIds({ since });

    expect(ids).toHaveLength(1203);
    expect(new Set(ids).size).toBe(1203);
    expect(ids).not.toContain("too-old");
    expect(ids).not.toContain("own");
  });
});

describe("reading the attachments of listed messages", () => {
  test("returns each PDF with its sender and the id earlier syncs stored it under", async () => {
    mailbox.push(invoiceEmail("o1", "2026-01-15T09:00:00Z"));

    const [attachment, ...rest] =
      await connectedProvider().getMessageAttachments(["o1"]);

    expect(rest).toEqual([]);
    expect(attachment).toMatchObject({
      filename: "o1.pdf",
      mimeType: "application/pdf",
      website: "vendor.example",
      senderEmail: "billing@mail.vendor.example",
      // sha256("o1_o1.pdf"): what the dedup against existing inbox rows keys on.
      referenceId:
        "a7c64b1e7cdbee72bc2e18c878ef94c7e06d82c2abd7d26eb4a8cbd3af3b5761",
    });
    expect(attachment?.data.toString()).toBe("%PDF o1");
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
    mailbox.push(invoiceEmail("o1", "2026-01-15T09:00:00Z"));
    mailbox.push(invoiceEmail("o2", "2026-01-15T10:00:00Z"));
    failures.o2 = graphError(503, "ServiceNotAvailable");

    const read = connectedProvider().getMessageAttachments(["o1", "o2"]);

    await expect(read).rejects.toBeInstanceOf(InboxSyncError);
  });
});
