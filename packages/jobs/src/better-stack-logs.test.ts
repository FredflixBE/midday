import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { betterStackLogExporters } from "./better-stack-logs";

describe("betterStackLogExporters", () => {
  test("exports nothing unless both the token and the host are set", () => {
    expect(betterStackLogExporters({})).toEqual([]);
    expect(
      betterStackLogExporters({ BETTER_STACK_JOBS_SOURCE_TOKEN: "t" }),
    ).toEqual([]);
    expect(
      betterStackLogExporters({
        BETTER_STACK_JOBS_INGESTING_HOST: "s1.eu-fsn-3.betterstackdata.com",
      }),
    ).toEqual([]);
  });

  test("a task's log line reaches Better Stack's OpenTelemetry endpoint with the run id", async () => {
    const received: {
      path: string;
      authorization: string | null;
      body: string;
    }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const raw = Buffer.from(await request.arrayBuffer());
        received.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body:
            request.headers.get("content-encoding") === "gzip"
              ? gunzipSync(raw).toString("utf8")
              : raw.toString("utf8"),
        });
        return new Response("{}", { status: 200 });
      },
    });

    try {
      const [exporter, ...rest] = betterStackLogExporters({
        BETTER_STACK_JOBS_SOURCE_TOKEN: "jobs-token",
        BETTER_STACK_JOBS_INGESTING_HOST: `http://127.0.0.1:${server.port}`,
      });
      expect(exporter).toBeDefined();
      expect(rest).toEqual([]);

      // The shape Trigger gives it: TaskContextLogProcessor in
      // @trigger.dev/core stamps the run's attributes on each record before
      // any exporter sees it, flattened under "$metadata", so the run id
      // arrives as `$metadata.ctx.run.id`.
      const provider = new LoggerProvider({
        processors: [new SimpleLogRecordProcessor(exporter!)],
      });
      provider.getLogger("task").emit({
        body: "Synced 12 transactions",
        attributes: { "$metadata.ctx.run.id": "run_abc123" },
      });
      await provider.forceFlush();
      await provider.shutdown();

      expect(received).toHaveLength(1);
      expect(received[0]?.path).toBe("/v1/logs");
      expect(received[0]?.authorization).toBe("Bearer jobs-token");
      expect(received[0]?.body).toContain("Synced 12 transactions");
      expect(received[0]?.body).toContain('"key":"$metadata.ctx.run.id"');
      expect(received[0]?.body).toContain("run_abc123");
    } finally {
      server.stop(true);
    }
  });
});
