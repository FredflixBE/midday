import "../setup";
import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../../mcp/server";
import {
  awaitingItem,
  daysBetween,
  quoteDetail,
  quoteListItem,
  todayUtc,
} from "../../mcp/tools/quotes";
import type { McpContext } from "../../mcp/types";

function server(scopes: McpContext["scopes"]) {
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
  return Object.keys(
    (s as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools,
  );
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
    productNames: { [productId]: "Development" },
    versions: [
      {
        version: 1,
        status: "sent",
        mode: "firm",
        issueDate: "2026-09-10",
        validUntil: "2026-10-10",
        expired: false,
        sentAt: "2026-09-12 09:30:00+00",
        sentTo: "buyer@example.com",
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
      name: "Fixed",
      recommended: true,
      adjustment: -5,
      totals: { total: { amount: 2112, max: null } },
      paymentSchedule: [{ label: "Start", percent: 100, amount: 2112 }],
    });
    expect(scenario!.lines).toEqual([
      { id: "sec", type: "section", title: "Build" },
      {
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
});
