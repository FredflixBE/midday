import pino, { type DestinationStream, type LoggerOptions } from "pino";

const prettyOptions = {
  colorize: true,
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  messageFormat: "{msg}",
  hideObject: false,
  singleLine: false,
  useLevelLabels: true,
  levelFirst: true,
};

// Field names that hold a credential. Masked wherever a caller puts one, at
// the top of a log line or one object down, because once Better Stack is on a
// line leaves our host. pino cannot match a key at any depth; two levels
// cover every logger call in the repo today.
const SECRET_KEYS = [
  "authorization",
  "Authorization",
  "cookie",
  "password",
  "secret",
  "clientSecret",
  "client_secret",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
];

const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`]);

type BaseLoggerOptions = {
  level: string;
  /** Pretty-print to stdout for development instead of structured JSON. */
  pretty: boolean;
  /** Where stdout lines go; only tests replace it. */
  destination?: DestinationStream;
  /** A second output, beside stdout, when Better Stack is configured. */
  betterStack?: DestinationStream;
};

/**
 * Create the base pino logger instance
 */
export function createBaseLogger({
  level,
  pretty,
  destination,
  betterStack,
}: BaseLoggerOptions): pino.Logger {
  const options: LoggerOptions = {
    level,
    serializers: {
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,
    },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };

  const prettyTransport = {
    target: "pino-pretty",
    options: prettyOptions,
  };

  if (!betterStack) {
    if (destination) return pino(options, destination);
    // No stream argument, as before Better Stack: pino then writes through
    // `process.stdout` (Bun replaces its `write`), which keeps log lines in
    // order with the `console.*` output around them.
    return pino({ ...options, ...(pretty && { transport: prettyTransport }) });
  }

  const stdout =
    destination ?? (pretty ? pino.transport(prettyTransport) : process.stdout);

  // A multistream output defaults to "info" and would drop debug lines the
  // logger let through, so both take everything and the logger's own level
  // (which `setLogLevel` changes) is the only filter.
  return pino(
    options,
    pino.multistream([
      { level: "trace", stream: stdout },
      { level: "trace", stream: betterStack },
    ]),
  );
}
