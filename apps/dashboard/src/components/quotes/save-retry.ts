/**
 * When a refused draft save is worth sending again (FF-1648).
 *
 * A draft save carries the whole of what changed, so a retry is simply the
 * next flush: it sends `pending`, which by then holds the refused changes
 * under anything typed since. That is why this decides only *whether* and
 * *when*, and never what to send.
 */

/** Consecutive failures after which the person is told instead. */
export const MAX_SAVE_ATTEMPTS = 5;

/** The wait before the first retry; each one after it waits twice as long. */
const FIRST_DELAY_MS = 1000;

/**
 * Refusals the same payload will earn again. Retrying these spends the whole
 * backoff before saying anything, when the answer is already known.
 */
const FINAL = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNPROCESSABLE_CONTENT",
]);

export type RetryDecision = { retry: true; delayMs: number } | { retry: false };

/**
 * What to do after `failures` consecutive refusals, the last of them `error`.
 *
 * An error with no code is a network blip — `Failed to fetch` is the one
 * Frederik hit — and is exactly the case worth retrying, so anything this
 * does not recognise is treated as worth another go.
 */
export function planRetry(error: unknown, failures: number): RetryDecision {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (typeof code === "string" && FINAL.has(code)) return { retry: false };
  if (failures >= MAX_SAVE_ATTEMPTS) return { retry: false };
  return { retry: true, delayMs: FIRST_DELAY_MS * 2 ** (failures - 1) };
}
