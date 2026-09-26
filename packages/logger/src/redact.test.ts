import { describe, expect, test } from "bun:test";
import { createBaseLogger } from "./base.js";
import { type BetterStackClient, betterStackStream } from "./better-stack.js";

function shipped(log: (logger: ReturnType<typeof createBaseLogger>) => void) {
  const received: { message: string; context: Record<string, unknown> }[] = [];
  const client: BetterStackClient = {
    log: async (message, _level, context) => {
      received.push({ message, context: context as Record<string, unknown> });
    },
    flush: async () => undefined,
  };
  const stdout: string[] = [];
  const logger = createBaseLogger({
    level: "info",
    pretty: false,
    destination: { write: (line: string) => stdout.push(line) },
    betterStack: betterStackStream(client),
  });
  log(logger);
  return { received, stdout, text: JSON.stringify(received) };
}

describe("what leaves for Better Stack", () => {
  test("credential fields are masked at any depth and in any letter case", () => {
    const { received, text } = shipped((logger) =>
      logger.info(
        {
          accessToken: "s-1",
          refresh_token: "s-2",
          apiKey: "s-3",
          "x-api-key": "s-4",
          password: "s-5",
          clientSecret: "s-6",
          tokens: { id_token: "s-7", bearerToken: "s-8" },
          headers: { Authorization: "Bearer s-9", Cookie: "sid=s-10" },
          err: { config: { headers: { authorization: "Bearer s-11" } } },
          connections: [{ token: "s-12" }],
          teamId: "team-1",
        },
        "connected",
      ),
    );

    for (let i = 1; i <= 12; i++) expect(text).not.toContain(`s-${i}"`);
    const context = received[0]?.context ?? {};
    expect(context.teamId).toBe("team-1");
    expect(context.accessToken).toBe("[redacted]");
    expect(context.connections).toEqual([{ token: "[redacted]" }]);
  });

  test("a failed query keeps its SQL but not the values it wrote", () => {
    // What drizzle-orm's DrizzleQueryError carries: the values sit in its
    // message, in the first line of its stack, and as `params`.
    const failure = Object.assign(
      new Error(
        'Failed query: insert into "transactions" ("name", "amount", "iban") values ($1, $2, $3)\nparams: ACME BV,1234.5,BE71096123456769',
      ),
      {
        query:
          'insert into "transactions" ("name", "amount", "iban") values ($1, $2, $3)',
        params: ["ACME BV", 1234.5, "BE71096123456769"],
      },
    );

    const { received, text } = shipped((logger) => {
      logger.error(
        { message: failure.message, stack: failure.stack, error: failure },
        `[tRPC] transactions.create ${failure.message}`,
      );
    });

    for (const value of ["ACME BV", "1234.5", "BE71096123456769"]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('insert into \\"transactions\\"');
    expect(received[0]?.message).toContain("params: [redacted]");
    expect(received[0]?.context.message_field).toBe(
      'Failed query: insert into "transactions" ("name", "amount", "iban") values ($1, $2, $3)\nparams: [redacted]',
    );
    expect(String(received[0]?.context.stack)).toContain("\n    at ");
  });

  test("ordinary fields are left alone", () => {
    const { received } = shipped((logger) =>
      logger.info(
        {
          tokenCount: 3,
          tokens: 12,
          params: { userId: "u-1" },
          requestId: "r",
        },
        "chat",
      ),
    );

    expect(received[0]?.context).toMatchObject({
      tokenCount: 3,
      tokens: 12,
      params: { userId: "u-1" },
      requestId: "r",
    });
  });
});
