import "../setup";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptQuoteVersion,
  createQuote,
  getPricedQuote,
  getQuote,
  markQuoteVersionSent,
  QuoteInputError,
  reviseQuote,
  setQuoteOutcome,
  undoQuoteAcceptance,
} from "@midday/db/queries";
import { createMcpServer } from "../../mcp/server";
import {
  awaitingItem,
  daysBetween,
  quoteDetail,
  quoteListItem,
  todayUtc,
} from "../../mcp/tools/quotes";
import type { McpContext } from "../../mcp/types";
import { asMock } from "../setup";

type Tool = {
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: { parse: (args: unknown) => unknown };
  handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
};
type ToolResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  structuredContent?: { data: Record<string, unknown> };
};

function tools(scopes: McpContext["scopes"]) {
  const s = createMcpServer({
    db: {} as McpContext["db"],
    teamId: "test-team-id",
    userId: "test-user-id",
    userEmail: "test@example.com",
    scopes,
    apiUrl: "https://api.example.test",
    timezone: "UTC",
    locale: "en",
    countryCode: "BE",
    dateFormat: null,
    timeFormat: 24,
  });
  return (s as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;
}

function server(scopes: McpContext["scopes"]) {
  return Object.keys(tools(scopes));
}

/** Calls a tool the way the transport does: its input checked first. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = tools(["invoices.read", "invoices.write"])[name]!;
  return tool.handler(tool.inputSchema.parse(args), {});
}

const row = (extra: Record<string, unknown> = {}) =>
  ({
    id: "q1",
    quoteNumber: "OFF-0007",
    title: "Website",
    customerName: "Example Customer",
    kind: "project",
    currency: "EUR",
    outcome: "open",
    outcomeReason: null,
    version: {
      version: 2,
      status: "draft",
      mode: "estimate",
      issueDate: "2026-09-10",
      validUntil: "2026-10-10",
      expired: false,
    },
    held: {
      id: "v1",
      version: 1,
      status: "sent",
      sentAt: "2026-09-12 09:30:00+00",
      sentTo: "buyer@example.com",
      validUntil: "2026-09-25",
      expired: false,
    },
    headline: { amount: { amount: 740000, max: 888000 }, per: "total" },
    ...extra,
  }) as unknown as Parameters<typeof quoteListItem>[0];

describe("quote tools", () => {
  test("are there with invoices.read, and none of them writes", () => {
    const names = server(["invoices.read"]);
    expect(names).toContain("quotes_list");
    expect(names).toContain("quotes_get");
    expect(names).toContain("quotes_awaiting_answer");
    expect(names.filter((n) => n.startsWith("quotes_"))).toHaveLength(3);
  });

  const WRITES = [
    "quotes_create",
    "quotes_revise",
    "quotes_mark_sent",
    "quotes_accept",
    "quotes_undo_acceptance",
    "quotes_set_outcome",
  ];

  test("that write are there with invoices.write, and only with it", () => {
    const all = tools(["invoices.write"]);
    for (const name of WRITES) {
      expect(all[name]?.annotations.readOnlyHint).toBe(false);
    }
    expect(all.quotes_undo_acceptance?.annotations.destructiveHint).toBe(true);
    expect(server(["invoices.read"]).some((n) => WRITES.includes(n))).toBe(
      false,
    );
  });

  test("are not there without it", () => {
    expect(
      server(["transactions.read"]).some((n) => n.startsWith("quotes_")),
    ).toBe(false);
  });
});

describe("days", () => {
  test("count whole UTC days, from a timestamp or a date", () => {
    expect(daysBetween("2026-09-12 09:30:00+00", "2026-09-19")).toBe(7);
    expect(daysBetween("2026-09-19", "2026-09-25")).toBe(6);
    expect(daysBetween("2026-09-19", "2026-09-19")).toBe(0);
    expect(todayUtc(new Date("2026-09-19T23:30:00Z"))).toBe("2026-09-19");
  });
});

describe("a quote in the list", () => {
  test("has its state, what the client holds, and its amount in the currency", () => {
    const item = quoteListItem(row());
    expect(item).toMatchObject({
      quoteNumber: "OFF-0007",
      state: "Draft",
      latestVersion: { version: 2, status: "draft" },
      held: { version: 1, sentTo: "buyer@example.com", expired: false },
      headline: { amount: 7400, max: 8880, per: "total" },
    });
    expect(item.url).toEndWith("/quotes/q1");
  });

  test("awaiting an answer, with days since sending and until expiry", () => {
    expect(awaitingItem(row(), "2026-09-19")).toMatchObject({
      daysSinceSent: 7,
      daysUntilExpiry: 6,
    });
  });
});

describe("one quote", () => {
  const productId = "p-dev";
  const priced = {
    id: "q1",
    quoteNumber: "OFF-0007",
    title: "Website",
    customerName: "Example Customer",
    kind: "project",
    language: "en",
    currency: "EUR",
    outcome: "open",
    outcomeReason: null,
    outcomeAt: null,
    trackerProjectId: null,
    productNames: { [productId]: "Development" },
    versions: [
      {
        id: "v1",
        version: 1,
        status: "sent",
        mode: "firm",
        issueDate: "2026-09-10",
        validUntil: "2026-10-10",
        expired: false,
        sentAt: "2026-09-12 09:30:00+00",
        sentTo: "buyer@example.com",
        acceptedScenarioId: null,
        acceptedOptionalLineIds: null,
        acceptedAt: null,
        acceptedByName: null,
        poNumber: null,
        content: {
          blocks: [],
          rates: { productRates: {}, volumeTiers: [], termTiers: [] },
          displayUnit: "days",
          hoursPerDay: 8,
          scenarios: [
            {
              id: "s1",
              name: "Fixed",
              recommended: true,
              pricing: "fixed",
              capped: false,
              recurrence: null,
              adjustmentOverride: null,
              paymentSchedule: [],
              lines: [
                { id: "sec", type: "section", title: "Build" },
                {
                  id: "l1",
                  type: "item",
                  title: "Pages",
                  description: null,
                  productId,
                  hours: 12,
                  hoursMax: null,
                  optional: false,
                  once: false,
                },
              ],
            },
          ],
        },
        pricing: {
          scenarios: [
            {
              scenarioId: "s1",
              adjustment: -5,
              lines: [
                {
                  lineId: "l1",
                  productId,
                  hours: 12,
                  hoursMax: null,
                  rate: 17600,
                  amount: 211200,
                  amountMax: null,
                  optional: false,
                  once: false,
                },
              ],
              totals: {
                kind: "project",
                total: { amount: 211200, max: null },
                hours: { amount: 12, max: null },
                capped: false,
              },
              paymentSchedule: [
                { label: "Start", percent: 100, amount: 211200 },
              ],
            },
          ],
        },
      },
    ],
  } as unknown as Parameters<typeof quoteDetail>[0];

  test("names each line's product and prices it in the currency, in its unit", () => {
    const detail = quoteDetail(priced);
    expect(detail.state).toBe("Sent");
    const [version] = detail.versions;
    expect(version).toMatchObject({ version: 1, displayUnit: "days" });
    const [scenario] = version!.scenarios;
    expect(scenario).toMatchObject({
      id: "s1",
      name: "Fixed",
      recommended: true,
      adjustment: -5,
      totals: { total: { amount: 2112, max: null } },
      paymentSchedule: [{ label: "Start", percent: 100, amount: 2112 }],
    });
    expect(scenario!.lines).toEqual([
      { id: "sec", type: "section", title: "Build" },
      {
        id: "l1",
        type: "item",
        title: "Pages",
        description: null,
        product: "Development",
        hours: 12,
        hoursMax: null,
        quantity: 1.5,
        quantityMax: null,
        hourlyRate: 176,
        amount: 2112,
        amountMax: null,
        optional: false,
        once: false,
      },
    ]);
  });

  test("carries the ids a write names, and what an acceptance recorded", () => {
    const detail = quoteDetail(priced);
    expect(detail).toMatchObject({ trackerProjectId: null });
    expect(detail.versions[0]).toMatchObject({
      id: "v1",
      acceptance: null,
    });

    const accepted = quoteDetail({
      ...priced,
      trackerProjectId: "t1",
      versions: priced.versions.map((v) => ({
        ...v,
        status: "accepted",
        acceptedScenarioId: "s1",
        acceptedOptionalLineIds: [],
        acceptedAt: "2026-09-20 10:00:00+00",
        acceptedByName: "A. Buyer",
        poNumber: "PO-1",
      })),
    } as typeof priced);
    expect(accepted).toMatchObject({ trackerProjectId: "t1" });
    expect(accepted.versions[0]!.acceptance).toEqual({
      scenarioId: "s1",
      optionalLineIds: [],
      acceptedAt: "2026-09-20 10:00:00+00",
      acceptedByName: "A. Buyer",
      poNumber: "PO-1",
    });
  });
});

const Q = "a1b2c3d4-0000-4000-8000-000000000001";
const C = "a1b2c3d4-0000-4000-8000-000000000002";

/** A quote as `getQuote` returns it: versions newest first. */
function stored(
  versions: ({
    id: string;
    status: string;
  } & Record<string, unknown>)[],
) {
  return {
    id: Q,
    versions: versions.map((v, i) => ({
      acceptanceFilePath: null,
      ...v,
      version: versions.length - i,
    })),
  };
}

/** What `getPricedQuote` returns once a write is done: enough to shape. */
const pricedAfter = {
  id: Q,
  quoteNumber: "OFF-0008",
  title: "Website",
  customerName: "Example Customer",
  kind: "project",
  language: "en",
  currency: "EUR",
  outcome: "open",
  outcomeReason: null,
  outcomeAt: null,
  trackerProjectId: null,
  productNames: {},
  versions: [
    {
      id: "v1",
      version: 1,
      status: "draft",
      mode: "estimate",
      issueDate: "2026-09-26",
      validUntil: "2026-10-26",
      expired: false,
      sentAt: null,
      sentTo: null,
      content: {
        blocks: [],
        rates: { productRates: {}, volumeTiers: [], termTiers: [] },
        displayUnit: "hours",
        hoursPerDay: 8,
        scenarios: [],
      },
      pricing: { scenarios: [] },
    },
  ],
};

describe("writing a quote", () => {
  beforeEach(() => {
    for (const fn of [
      createQuote,
      getQuote,
      getPricedQuote,
      reviseQuote,
      markQuoteVersionSent,
      acceptQuoteVersion,
      undoQuoteAcceptance,
      setQuoteOutcome,
    ]) {
      asMock(fn).mockReset();
      asMock(fn).mockImplementation(() => Promise.resolve({ id: Q }));
    }
    asMock(getPricedQuote).mockImplementation(() =>
      Promise.resolve(pricedAfter),
    );
  });

  test("creates it on the caller's team, by the caller, and hands it back whole", async () => {
    const result = await call("quotes_create", {
      customerId: C,
      title: "Website",
      kind: "project",
      language: "en",
    });

    expect(asMock(createQuote).mock.calls[0]?.[1]).toMatchObject({
      teamId: "test-team-id",
      userId: "test-user-id",
      customerId: C,
      title: "Website",
      kind: "project",
      language: "en",
    });
    expect(asMock(getPricedQuote).mock.calls[0]?.[1]).toMatchObject({
      id: Q,
      teamId: "test-team-id",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.data).toMatchObject({
      quoteNumber: "OFF-0008",
      versions: [{ id: "v1", status: "draft" }],
    });
  });

  test("another team's customer is not found", async () => {
    asMock(createQuote).mockImplementation(() => Promise.resolve(null));

    const result = await call("quotes_create", {
      customerId: C,
      title: "Website",
      kind: "project",
      language: "en",
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]!.text).toBe("Customer not found");
  });

  test("a rule the queries keep comes back as the error, in its own words", async () => {
    asMock(reviseQuote).mockImplementation(() =>
      Promise.reject(new QuoteInputError("This quote already has a draft")),
    );

    const result = await call("quotes_revise", { quoteId: Q });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]!.text).toBe("This quote already has a draft");
    expect(asMock(reviseQuote).mock.calls[0]?.[1]).toEqual({
      teamId: "test-team-id",
      quoteId: Q,
    });
  });

  test("marks the draft sent and keeps its PDF", async () => {
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(
        stored([
          { id: "v2", status: "draft" },
          { id: "v1", status: "sent" },
        ]),
      ),
    );

    const result = await call("quotes_mark_sent", {
      quoteId: Q,
      sentTo: "buyer@example.com",
    });

    expect(result.isError).toBeUndefined();
    const params = asMock(markQuoteVersionSent).mock.calls[0]?.[1] as {
      versionId: string;
      sentTo: string | null;
      storePdf: unknown;
    };
    expect(params).toMatchObject({
      teamId: "test-team-id",
      versionId: "v2",
      sentTo: "buyer@example.com",
    });
    expect(typeof params.storePdf).toBe("function");
  });

  test("a quote with no draft has nothing to send", async () => {
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(stored([{ id: "v1", status: "sent" }])),
    );

    const result = await call("quotes_mark_sent", { quoteId: Q });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]!.text).toMatch(/no draft/);
    expect(asMock(markQuoteVersionSent).mock.calls).toHaveLength(0);
  });

  test("a quote that is not the team's is not found", async () => {
    asMock(getQuote).mockImplementation(() => Promise.resolve(null));

    for (const name of [
      "quotes_mark_sent",
      "quotes_undo_acceptance",
    ] as const) {
      const result = await call(name, { quoteId: Q });
      expect(result.content[0]!.text).toBe("Quote not found");
    }
    const accept = await call("quotes_accept", {
      quoteId: Q,
      scenarioId: "s1",
    });
    expect(accept.content[0]!.text).toBe("Quote not found");
  });

  test("accepts the version the client holds, not the revision beside it", async () => {
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(
        stored([
          { id: "v2", status: "draft" },
          { id: "v1", status: "sent" },
        ]),
      ),
    );

    await call("quotes_accept", {
      quoteId: Q,
      scenarioId: "s1",
      optionalLineIds: ["l3"],
      acceptedAt: "2026-09-25",
      acceptedByName: "A. Buyer",
      poNumber: "PO-1",
    });

    const params = asMock(acceptQuoteVersion).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(params).toMatchObject({
      teamId: "test-team-id",
      versionId: "v1",
      scenarioId: "s1",
      optionalLineIds: ["l3"],
      acceptedAt: "2026-09-25",
      acceptedByName: "A. Buyer",
      poNumber: "PO-1",
      acceptanceFilePath: null,
    });
    expect(typeof params.storePdf).toBe("function");
  });

  test("recording an acceptance again keeps what it does not name, the order form included", async () => {
    const form = ["test-team-id", "quotes", "order.pdf"];
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(
        stored([
          {
            id: "v1",
            status: "accepted",
            acceptanceFilePath: form,
            acceptedScenarioId: "s1",
            acceptedOptionalLineIds: ["l3"],
            acceptedAt: "2026-09-20 00:00:00+00",
            acceptedByName: "A. Buyer",
            poNumber: "PO-1",
          },
        ]),
      ),
    );

    await call("quotes_accept", {
      quoteId: Q,
      scenarioId: "s1",
      poNumber: "PO-2",
    });
    expect(asMock(acceptQuoteVersion).mock.calls[0]?.[1]).toMatchObject({
      versionId: "v1",
      scenarioId: "s1",
      optionalLineIds: ["l3"],
      acceptedAt: "2026-09-20 00:00:00+00",
      acceptedByName: "A. Buyer",
      poNumber: "PO-2",
      acceptanceFilePath: form,
    });

    // Another scenario's optional lines are not this one's.
    await call("quotes_accept", { quoteId: Q, scenarioId: "s2" });
    expect(asMock(acceptQuoteVersion).mock.calls[1]?.[1]).toMatchObject({
      scenarioId: "s2",
      optionalLineIds: [],
      acceptanceFilePath: form,
    });
  });

  test("a quote never sent has nothing to accept", async () => {
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(stored([{ id: "v1", status: "draft" }])),
    );

    const result = await call("quotes_accept", {
      quoteId: Q,
      scenarioId: "s1",
    });

    expect(result).toMatchObject({ isError: true });
    expect(asMock(acceptQuoteVersion).mock.calls).toHaveLength(0);
  });

  test("takes back the accepted version, and only that", async () => {
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(stored([{ id: "v1", status: "accepted" }])),
    );

    await call("quotes_undo_acceptance", { quoteId: Q });

    expect(asMock(undoQuoteAcceptance).mock.calls[0]?.[1]).toEqual({
      teamId: "test-team-id",
      versionId: "v1",
    });

    asMock(getQuote).mockImplementation(() =>
      Promise.resolve(stored([{ id: "v1", status: "sent" }])),
    );
    const result = await call("quotes_undo_acceptance", { quoteId: Q });
    expect(result).toMatchObject({ isError: true });
    expect(asMock(undoQuoteAcceptance).mock.calls).toHaveLength(1);
  });

  test("records a quote lost, with the reason; won is not an outcome set here", async () => {
    await call("quotes_set_outcome", {
      quoteId: Q,
      outcome: "lost",
      reason: "Went with a cheaper offer",
    });

    expect(asMock(setQuoteOutcome).mock.calls[0]?.[1]).toEqual({
      teamId: "test-team-id",
      quoteId: Q,
      outcome: "lost",
      reason: "Went with a cheaper offer",
    });
    await expect(
      call("quotes_set_outcome", { quoteId: Q, outcome: "won" }),
    ).rejects.toThrow();
  });
});
