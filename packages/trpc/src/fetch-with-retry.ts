const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_ERROR = "TimeoutError";

const MAX_RETRIES = 1;
const TIMEOUT_MS = 5_000;

type FetchWithRetryOptions = {
  /** Abort an attempt after this long. */
  timeoutMs?: number;
  /**
   * Retry an attempt that hit the timeout. Off for calls that are slow by
   * nature: repeating one only doubles the wait, and a bank fetch repeated
   * counts against the account's daily access limit.
   */
  retryTimeouts?: boolean;
};

function isRetryable(err: any, retryTimeouts: boolean): boolean {
  const code = err?.cause?.code ?? err?.code ?? "";
  if (RETRYABLE_CODES.has(code)) return true;

  return retryTimeouts && err?.name === TIMEOUT_ERROR;
}

/**
 * Fetch wrapper for service-to-service calls over a private network.
 *
 * During API redeployments, DNS propagation on the private network can
 * lag and pooled keep-alive connections may point at dead containers. The
 * timeout ensures we fail fast instead of hanging, and the retry with
 * exponential backoff gives the mesh time to converge.
 */
export function createFetchWithRetry({
  timeoutMs = TIMEOUT_MS,
  retryTimeouts = true,
}: FetchWithRetryOptions = {}) {
  return async function fetchWithRetry(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, timeout])
          : timeout;

        const headers = new Headers(init?.headers);

        return await fetch(input, { ...init, signal, headers });
      } catch (err: any) {
        lastError = err;
        if (!isRetryable(err, retryTimeouts) || attempt === MAX_RETRIES) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
    throw lastError;
  };
}

/** The default for internal calls: 5 s per attempt, one retry. */
export const fetchWithRetry = createFetchWithRetry();
