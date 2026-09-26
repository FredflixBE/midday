import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createBaseLogger } from "./base.js";
import {
  type BetterStackClient,
  betterStackConfig,
  betterStackStream,
  createBetterStackClient,
  flushWithin,
} from "./better-stack.js";

function captureStream() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: { write: (line: string) => lines.push(JSON.parse(line)) },
  };
}

function fakeClient() {
  const calls: { message: string; level: string; context: object }[] = [];
  const client: BetterStackClient = {
    log: async (message, level, context) => {
      calls.push({ message, level, context });
    },
    flush: async () => undefined,
  };
  return { calls, client };
}

describe("betterStackConfig", () => {
  test("is off unless both the token and the host are set", () => {
    expect(betterStackConfig({})).toBeNull();
    expect(betterStackConfig({ BETTER_STACK_SOURCE_TOKEN: "t" })).toBeNull();
    expect(
      betterStackConfig({ BETTER_STACK_INGESTING_HOST: "s1.example.com" }),
    ).toBeNull();
    expect(
      betterStackConfig({
        BETTER_STACK_SOURCE_TOKEN: " ",
        BETTER_STACK_INGESTING_HOST: "s1.example.com",
      }),
    ).toBeNull();
  });

  test("takes the host as Better Stack shows it, without a scheme", () => {
    expect(
      betterStackConfig({
        BETTER_STACK_SOURCE_TOKEN: "t",
        BETTER_STACK_INGESTING_HOST: "s1.eu-nbg-2.betterstackdata.com",
      }),
    ).toEqual({
      sourceToken: "t",
      endpoint: "https://s1.eu-nbg-2.betterstackdata.com",
    });
  });

  test("keeps a scheme when one is given", () => {
    expect(
      betterStackConfig({
        BETTER_STACK_SOURCE_TOKEN: "t",
        BETTER_STACK_INGESTING_HOST: "http://127.0.0.1:9999",
      })?.endpoint,
    ).toBe("http://127.0.0.1:9999");
  });
});

describe("a logger with Better Stack", () => {
  test("sends each line to both stdout and Better Stack, with its fields", () => {
    const stdout = captureStream();
    const { calls, client } = fakeClient();
    const logger = createBaseLogger({
      level: "info",
      pretty: false,
      destination: stdout.stream,
      betterStack: betterStackStream(client),
    });

    logger
      .child({ context: "banking" })
      .info({ requestId: "r1" }, "[banking] synced");

    expect(stdout.lines).toHaveLength(1);
    expect(stdout.lines[0]).toMatchObject({
      msg: "[banking] synced",
      requestId: "r1",
      context: "banking",
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.message).toBe("[banking] synced");
    expect(call?.level).toBe("info");
    expect(call?.context).toMatchObject({
      requestId: "r1",
      context: "banking",
    });
    expect(call?.context).toHaveProperty("dt");
    for (const key of ["msg", "time", "level", "v"]) {
      expect(call?.context).not.toHaveProperty(key);
    }
  });

  test("the logger's level decides, not a default on either output", () => {
    const stdout = captureStream();
    const { calls, client } = fakeClient();
    const logger = createBaseLogger({
      level: "debug",
      pretty: false,
      destination: stdout.stream,
      betterStack: betterStackStream(client),
    });

    logger.debug("detail");
    logger.trace("noise");

    expect(stdout.lines.map((l) => l.msg)).toEqual(["detail"]);
    expect(calls.map((c) => [c.message, c.level])).toEqual([
      ["detail", "debug"],
    ]);

    logger.level = "warn";
    logger.info("hidden");
    logger.error({ err: new Error("boom") }, "failed");

    expect(stdout.lines.map((l) => l.msg)).toEqual(["detail", "failed"]);
    expect(calls.map((c) => c.level)).toEqual(["debug", "error"]);
    expect(calls[1]?.context).toMatchObject({
      err: { type: "Error", message: "boom" },
    });
  });

  test("without Better Stack, only stdout gets the line", () => {
    const stdout = captureStream();
    const logger = createBaseLogger({
      level: "info",
      pretty: false,
      destination: stdout.stream,
    });

    logger.info({ a: 1 }, "hello");

    expect(stdout.lines).toHaveLength(1);
    expect(stdout.lines[0]).toMatchObject({ msg: "hello", a: 1, level: 30 });
  });
});

describe("stdout", () => {
  const originalWrite = process.stdout.write;
  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  // Capture what reaches process.stdout, the way Bun's console shares it.
  function captureProcessStdout() {
    const written: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    return written;
  }

  test("without Better Stack, lines go through process.stdout as they always did", () => {
    const written = captureProcessStdout();
    const logger = createBaseLogger({ level: "info", pretty: false });

    logger.info("in order");

    expect(written.join("")).toContain('"msg":"in order"');
  });

  test("with Better Stack, stdout still goes through process.stdout", () => {
    const written = captureProcessStdout();
    const logger = createBaseLogger({
      level: "info",
      pretty: false,
      betterStack: betterStackStream(fakeClient().client),
    });

    logger.info("in order");

    expect(written.join("")).toContain('"msg":"in order"');
  });
});

describe("betterStackStream", () => {
  test("a line it cannot read is skipped rather than thrown into the caller", () => {
    const { calls, client } = fakeClient();
    const stream = betterStackStream(client);

    expect(() => stream.write("not json\n")).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("a caller's own `message` field survives beside the log message", () => {
    const { calls, client } = fakeClient();
    const logger = createBaseLogger({
      level: "info",
      pretty: false,
      destination: captureStream().stream,
      betterStack: betterStackStream(client),
    });

    logger.info({ message: "from the provider" }, "sync failed");

    expect(calls[0]?.message).toBe("sync failed");
    expect(calls[0]?.context).toMatchObject({
      message_field: "from the provider",
    });
    expect(calls[0]?.context).not.toHaveProperty("message");
  });
});

describe("flushWithin", () => {
  test("waits for Better Stack to take the batch", async () => {
    let flushed = false;
    const client: BetterStackClient = {
      log: async () => undefined,
      flush: async () => {
        await Bun.sleep(20);
        flushed = true;
      },
    };

    await flushWithin(client, 1000);

    expect(flushed).toBe(true);
  });

  test("gives up after the time limit, so a dead Better Stack cannot hold shutdown", async () => {
    const client: BetterStackClient = {
      log: async () => undefined,
      flush: () => new Promise(() => undefined),
    };

    const started = performance.now();
    await flushWithin(client, 50);

    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a failed flush does not throw into shutdown", async () => {
    const client: BetterStackClient = {
      log: async () => undefined,
      flush: async () => {
        throw new Error("network down");
      },
    };

    await expect(flushWithin(client, 1000)).resolves.toBeUndefined();
  });
});

describe("the real Better Stack client", () => {
  test("posts a flushed line to the ingesting host with the source token", async () => {
    const received: { authorization: string | null; body: Buffer }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({
          authorization: request.headers.get("authorization"),
          body: gunzipSync(Buffer.from(await request.arrayBuffer())),
        });
        return new Response(null, { status: 202 });
      },
    });

    try {
      const client = createBetterStackClient({
        sourceToken: "source-token",
        endpoint: `http://127.0.0.1:${server.port}`,
      });
      const logger = createBaseLogger({
        level: "info",
        pretty: false,
        destination: captureStream().stream,
        betterStack: betterStackStream(client),
      });

      logger.info({ requestId: "r-42" }, "shipped to better stack");
      await flushWithin(client, 5000);

      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe("Bearer source-token");
      // The body is msgpack; its strings are stored as plain UTF-8.
      const body = received[0]?.body.toString("utf8") ?? "";
      expect(body).toContain("shipped to better stack");
      expect(body).toContain("r-42");
    } finally {
      server.stop(true);
    }
  });
});
