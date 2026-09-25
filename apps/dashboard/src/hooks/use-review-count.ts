import {
  partialMatchKey,
  type QueryClient,
  type QueryKey,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Invalidate `countKey` whenever a query under `listKey` is invalidated.
 * Returns the unsubscribe function.
 */
export function followInvalidations(
  queryClient: QueryClient,
  listKey: QueryKey,
  countKey: QueryKey,
) {
  return queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "invalidate" &&
      partialMatchKey(event.query.queryKey, listKey)
    ) {
      queryClient.invalidateQueries({ queryKey: countKey });
    }
  });
}

/**
 * How many transactions wait in the review queue (fulfilled, not exported).
 *
 * The badge used to load the whole queue, up to 10,000 rows, to count it
 * (FF-1713). It counts on the server now, which returns the same rows as the
 * review filter. What the old query did for free was refresh on every
 * invalidation of `transactions.get`, and the mutations that move a
 * transaction in or out of review (attaching a receipt, changing a status)
 * invalidate that list rather than the count. So the count follows the list's
 * invalidations.
 */
export function useReviewCount() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      followInvalidations(
        queryClient,
        trpc.transactions.get.infiniteQueryKey(),
        trpc.transactions.getReviewCount.queryKey(),
      ),
    [queryClient, trpc],
  );

  return useQuery(trpc.transactions.getReviewCount.queryOptions());
}
