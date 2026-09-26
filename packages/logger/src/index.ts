import type pino from "pino";
import { createBaseLogger } from "./base";
import {
  betterStackConfig,
  betterStackStream,
  createBetterStackClient,
  flushWithin,
} from "./better-stack";

/**
 * Better Stack receives every line too when its source token and ingesting
 * host are set; without them, output is stdout only.
 */
const betterStack = betterStackConfig(process.env);
const betterStackClient = betterStack
  ? createBetterStackClient(betterStack)
  : null;

const baseLogger = createBaseLogger({
  level: process.env.LOG_LEVEL || "info",
  pretty: process.env.LOG_PRETTY === "true",
  betterStack: betterStackClient
    ? betterStackStream(betterStackClient)
    : undefined,
});

/**
 * Create a logger adapter that wraps pino to match the existing API
 */
function createLoggerAdapter(pinoLogger: pino.Logger, prefixContext?: string) {
  // Format context with brackets if not already formatted
  const formatContext = (ctx?: string): string => {
    if (!ctx) return "";
    // If already has brackets, use as-is, otherwise wrap in brackets
    if (ctx.startsWith("[") && ctx.endsWith("]")) {
      return ctx;
    }
    return `[${ctx}]`;
  };

  const formattedContext = formatContext(prefixContext);

  return {
    info: (message: string, data?: object) => {
      try {
        const fullMessage = formattedContext
          ? `${formattedContext} ${message}`
          : message;
        if (data) {
          pinoLogger.info(data, fullMessage);
        } else {
          pinoLogger.info(fullMessage);
        }
      } catch (_error) {
        // Silently ignore logger stream errors to prevent crashes
        // This can happen when pino-pretty transport's stream is closing
      }
    },
    error: (message: string, data?: object) => {
      try {
        const fullMessage = formattedContext
          ? `${formattedContext} ${message}`
          : message;
        if (data) {
          pinoLogger.error(data, fullMessage);
        } else {
          pinoLogger.error(fullMessage);
        }
      } catch (_error) {
        // Silently ignore logger stream errors to prevent crashes
        // This can happen when pino-pretty transport's stream is closing
      }
    },
    warn: (message: string, data?: object) => {
      try {
        const fullMessage = formattedContext
          ? `${formattedContext} ${message}`
          : message;
        if (data) {
          pinoLogger.warn(data, fullMessage);
        } else {
          pinoLogger.warn(fullMessage);
        }
      } catch (_error) {
        // Silently ignore logger stream errors to prevent crashes
        // This can happen when pino-pretty transport's stream is closing
      }
    },
    debug: (message: string, data?: object) => {
      try {
        const fullMessage = formattedContext
          ? `${formattedContext} ${message}`
          : message;
        if (data) {
          pinoLogger.debug(data, fullMessage);
        } else {
          pinoLogger.debug(fullMessage);
        }
      } catch (_error) {
        // Silently ignore logger stream errors to prevent crashes
        // This can happen when pino-pretty transport's stream is closing
      }
    },
  };
}

/**
 * Default logger instance
 */
export const logger = createLoggerAdapter(baseLogger);

/**
 * Create a child logger with additional context
 * @param context - Context string to prepend to all log messages
 * @returns A new logger instance with the context
 *
 * @example
 * ```ts
 * const logger = createLoggerWithContext("my-component");
 * logger.info("Processing", { userId: 123 }); // Will log with "my-component" as context
 * ```
 */
export function createLoggerWithContext(context: string) {
  const childLogger = baseLogger.child({ context });
  return createLoggerAdapter(childLogger, context);
}

/**
 * Change the log level at runtime. Affects all existing child loggers.
 */
export function setLogLevel(level: string) {
  baseLogger.level = level;
}

/**
 * Send any lines still batched for Better Stack. Await this before
 * `process.exit`, or the last lines — the ones that say why the process
 * stopped — are lost. Waits at most `timeoutMs`; a no-op without Better Stack.
 */
export async function flushLogs(timeoutMs = 2000): Promise<void> {
  if (betterStackClient) await flushWithin(betterStackClient, timeoutMs);
}

export default logger;
