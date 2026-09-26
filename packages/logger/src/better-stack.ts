import { Logtail } from "@logtail/node";
import pino, { type DestinationStream } from "pino";

type LogtailLevel = Parameters<Logtail["log"]>[1];

export type BetterStackConfig = {
  sourceToken: string;
  endpoint: string;
};

/**
 * The part of the Better Stack client the logger uses — narrow so tests can
 * stand in for it.
 */
export type BetterStackClient = {
  log(message: string, level: string, context: object): Promise<unknown>;
  flush(): Promise<unknown>;
};

/**
 * Better Stack is on only when both the source token and its ingesting host
 * are set. Better Stack shows the host without a scheme; one is accepted
 * anyway so a test can point at plain http.
 */
export function betterStackConfig(
  env: Record<string, string | undefined>,
): BetterStackConfig | null {
  const sourceToken = env.BETTER_STACK_SOURCE_TOKEN?.trim();
  const host = env.BETTER_STACK_INGESTING_HOST?.trim();
  if (!sourceToken || !host) return null;

  return {
    sourceToken,
    endpoint: /^https?:\/\//.test(host) ? host : `https://${host}`,
  };
}

export function createBetterStackClient(
  config: BetterStackConfig,
): BetterStackClient {
  const logtail = new Logtail(config.sourceToken, {
    endpoint: config.endpoint,
    // Every line would otherwise be attributed to this file, the one place
    // that calls it, and the stack walk costs something on every line.
    captureStackContext: false,
  });

  return {
    log: (message, level, context) =>
      logtail.log(message, level as LogtailLevel, context),
    flush: () => logtail.flush(),
  };
}

// Fields pino writes on every line that Better Stack carries in its own
// columns: the message, the level, and the time (sent as `dt`).
const PINO_OWN_FIELDS = new Set(["msg", "time", "level", "v"]);

/**
 * A pino destination that forwards each line to Better Stack. It runs in the
 * logging process rather than in a pino transport worker, so shutdown can
 * await the send (see `flushWithin`) and nothing has to be resolvable by
 * module name at runtime — which a Trigger.dev bundle cannot promise.
 */
export function betterStackStream(
  client: BetterStackClient,
): DestinationStream {
  return {
    write(line: string) {
      let fields: Record<string, unknown>;
      try {
        fields = JSON.parse(line);
      } catch {
        // Never throw into the code that was logging; stdout still has it.
        return;
      }

      const { msg, time, level } = fields;
      const context: Record<string, unknown> = { dt: new Date(Number(time)) };
      for (const [key, value] of Object.entries(fields)) {
        if (!PINO_OWN_FIELDS.has(key)) context[key] = value;
      }
      // Better Stack stores the message under `message`, which would silently
      // replace a field of that name — keep it beside it instead.
      if ("message" in context) {
        context.message_field = context.message;
        delete context.message;
      }

      // The client counts and reports its own send failures; this only keeps
      // one from surfacing as an unhandled rejection.
      client
        .log(
          typeof msg === "string" ? msg : "",
          pino.levels.labels[Number(level)] ?? "info",
          context,
        )
        .catch(() => undefined);
    },
  };
}

/**
 * Send whatever is still batched, but never wait longer than `timeoutMs`: an
 * unreachable Better Stack must not hold a shutdown past the container's
 * grace period, and a failed send must not throw into it.
 */
export async function flushWithin(
  client: BetterStackClient,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([client.flush().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
