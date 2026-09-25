import type { AppRouter } from "@midday/api/trpc/routers/_app";
import { getApiUrl } from "@midday/utils/envs";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  splitLink,
} from "@trpc/client";
import superjson from "superjson";
import { createFetchWithRetry, fetchWithRetry } from "./fetch-with-retry";

/**
 * Calls that fetch from a bank through the provider rather than answering
 * from the API itself. A full history is paged in from Enable Banking and
 * can take well over the 5 s every other internal call gets.
 */
export const SLOW_PROCEDURES = new Set(["banking.getProviderTransactions"]);

/**
 * Just under `sync-account`'s `maxDuration` of 120 s, so the call fails
 * before the task is killed and the error says why.
 */
const SLOW_TIMEOUT_MS = 110_000;

const fetchSlow = createFetchWithRetry({
  timeoutMs: SLOW_TIMEOUT_MS,
  retryTimeouts: false,
});

/**
 * Where the API is. API_INTERNAL_URL, a private address on the same network,
 * wins when set; otherwise the API's public URL, resolved by `getApiUrl()` like
 * everywhere else — so an unset API_URL in production is an error naming it,
 * not a silent localhost that only ever worked on a laptop.
 */
function internalApiUrl() {
  const privateUrl = process.env.API_INTERNAL_URL?.replace(/\/+$/, "");
  return privateUrl || getApiUrl();
}

/**
 * Create a tRPC client for internal service-to-service calls.
 * Authenticates via INTERNAL_API_KEY header.
 */
export function createInternalClient() {
  const apiUrl = internalApiUrl();

  const internalApiKey = process.env.INTERNAL_API_KEY;

  if (!internalApiKey) {
    throw new Error(
      "INTERNAL_API_KEY environment variable is required for internal tRPC client",
    );
  }

  const trpcUrl = `${apiUrl}/trpc`;

  const headers = () => ({ "x-internal-key": internalApiKey });

  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        // Unbatched, so a slow call cannot hold up the calls batched with it.
        condition: (op) => SLOW_PROCEDURES.has(op.path),
        true: httpLink({
          url: trpcUrl,
          transformer: superjson,
          // @ts-expect-error -- see the batch link below
          fetch: fetchSlow,
          headers,
        }),
        false: httpBatchLink({
          url: trpcUrl,
          transformer: superjson,
          // @ts-expect-error -- native Response.body (ReadableStream<any>) is not structurally
          // compatible with tRPC's ResponseEsque (ReadableStream<Uint8Array>) due to getReader() generics
          fetch: fetchWithRetry,
          headers,
        }),
      }),
    ],
  });
}

/**
 * Pre-configured internal tRPC client singleton.
 * Import this directly in jobs and workers.
 */
let _client: ReturnType<typeof createInternalClient> | null = null;

export function getInternalClient() {
  if (!_client) {
    _client = createInternalClient();
  }
  return _client;
}
