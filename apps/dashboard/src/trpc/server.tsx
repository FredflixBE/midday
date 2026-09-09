import "server-only";

import type { AppRouter } from "@midday/api/trpc/routers/_app";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createTRPCClient, httpLink, loggerLink } from "@trpc/client";
import {
  createTRPCOptionsProxy,
  type TRPCQueryOptions,
} from "@trpc/tanstack-react-query";
import { cache } from "react";
import superjson from "superjson";
import { makeQueryClient } from "./query-client";
import {
  buildTRPCRequestHeaders,
  getServerRequestContext,
} from "./request-context";

// IMPORTANT: Create a stable getter for the query client that
//            will return the same client during the same request.
export const getQueryClient = cache(makeQueryClient);

// Server-side: prefer the internal API URL (skips DNS + TLS + proxy)
// Falls back to the public URL when no internal URL is configured
const API_BASE_URL =
  process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL;

const SSR_FETCH_TIMEOUT_MS = 8_000;

function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(SSR_FETCH_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  const headers = new Headers(init?.headers);

  return fetch(input, { ...init, signal, headers });
}

export const trpc = createTRPCOptionsProxy<AppRouter>({
  queryClient: getQueryClient,
  client: createTRPCClient({
    links: [
      httpLink({
        url: `${API_BASE_URL}/trpc`,
        transformer: superjson,
        fetch: fetchWithTimeout,
        async headers() {
          const requestContext = await getServerRequestContext();

          return buildTRPCRequestHeaders({
            session: requestContext.session,
            location: requestContext.location,
            traceHeaders: requestContext.traceHeaders,
          });
        },
      }),
      loggerLink({
        enabled: (opts) =>
          process.env.NODE_ENV === "development" ||
          (opts.direction === "down" && opts.result instanceof Error),
      }),
    ],
  }),
});

export function HydrateClient(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {props.children}
    </HydrationBoundary>
  );
}

export function prefetch<T extends ReturnType<TRPCQueryOptions<any>>>(
  queryOptions: T,
) {
  const queryClient = getQueryClient();

  if (queryOptions.queryKey[1]?.type === "infinite") {
    void queryClient.prefetchInfiniteQuery(queryOptions as any).catch(() => {
      // Avoid unhandled promise rejections from fire-and-forget prefetches.
    });
  } else {
    void queryClient.prefetchQuery(queryOptions).catch(() => {
      // Avoid unhandled promise rejections from fire-and-forget prefetches.
    });
  }
}

export function batchPrefetch<T extends ReturnType<TRPCQueryOptions<any>>>(
  queryOptionsArray: T[],
) {
  const queryClient = getQueryClient();

  for (const queryOptions of queryOptionsArray) {
    if (queryOptions.queryKey[1]?.type === "infinite") {
      void queryClient.prefetchInfiniteQuery(queryOptions as any).catch(() => {
        // Avoid unhandled promise rejections from fire-and-forget prefetches.
      });
    } else {
      void queryClient.prefetchQuery(queryOptions).catch(() => {
        // Avoid unhandled promise rejections from fire-and-forget prefetches.
      });
    }
  }
}

/**
 * Get a tRPC client for server-side API routes
 * Use this when you need to call mutations from API routes (e.g., webhooks, callbacks)
 * For queries, use the `trpc` proxy with `queryOptions` instead
 */
export async function getTRPCClient() {
  const requestContext = await getServerRequestContext();

  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${API_BASE_URL}/trpc`,
        transformer: superjson,
        fetch: fetchWithTimeout,
        headers: buildTRPCRequestHeaders({
          session: requestContext.session,
          location: requestContext.location,
          traceHeaders: requestContext.traceHeaders,
        }),
      }),
    ],
  });
}
