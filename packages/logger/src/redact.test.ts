import { describe, expect, test } from "bun:test";
import { createBaseLogger } from "./base.js";
import { betterStackStream } from "./better-stack.js";

function captureStream() {
  const lines: Record<string, any>[] = [];
  return {
    lines,
    stream: { write: (line: string) => lines.push(JSON.parse(line)) },
  };
}

describe("secrets never leave in a log line", () => {
  test("credential fields are masked at the top level and one level down", () => {
    const stdout = captureStream();
    const logger = createBaseLogger({
      level: "info",
      pretty: false,
      destination: stdout.stream,
    });

    logger.info(
      {
        accessToken: "a",
        refresh_token: "b",
        apiKey: "c",
        password: "d",
        clientSecret: "e",
        authorization: "Bearer f",
        tokens: { access_token: "g", refreshToken: "h" },
        headers: { Authorization: "Bearer i", cookie: "sid=j" },
        teamId: "team-1",
      },
      "connected",
    );

    const line = stdout.lines[0] ?? {};
    const text = JSON.stringify(line);
    for (const secret of [
      '"a"',
      '"b"',
      '"c"',
      '"d"',
      '"e"',
      "Bearer",
      '"g"',
      '"h"',
      "sid=j",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(line.teamId).toBe("team-1");
    expect(line.tokens.access_token).toBe("[redacted]");
    expect(line.headers.Authorization).toBe("[redacted]");
  });

  test("Better Stack gets the masked line, not the original", () => {
    const received: object[] = [];
    const logger = createBaseLogger({
      level: "info",
      pretty: false,
      destination: captureStream().stream,
      betterStack: betterStackStream({
        log: async (_message, _level, context) => {
          received.push(context);
        },
        flush: async () => undefined,
      }),
    });

    logger.info({ accessToken: "secret-value" }, "refreshed");

    expect(JSON.stringify(received)).not.toContain("secret-value");
  });
});
