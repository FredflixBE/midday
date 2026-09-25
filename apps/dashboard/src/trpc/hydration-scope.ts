import {
  type DehydratedState,
  defaultShouldDehydrateQuery,
  dehydrate,
  hashKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

type QueryRef = { queryKey: QueryKey };

/**
 * Which queries the HydrateClient boundaries of one request have sent, so
 * that no query's data crosses to the browser more than once.
 *
 * Pages render while their layout is still awaiting, so the order in which
 * boundaries dehydrate is not the order they nest in. A layout therefore
 * claims its queries up front and always sends those itself, because the
 * header and sidebar render outside every page's boundary. Anything else goes
 * with whichever boundary dehydrates first: that is either the page's own
 * boundary or a layout's, and a layout's encloses the page.
 */
export type HydrationScope = {
  claimed: Set<string>;
  sent: Set<string>;
};

export function createHydrationScope(): HydrationScope {
  return { claimed: new Set(), sent: new Set() };
}

/** Call before the layout's first await, or a page may send them too. */
export function claimForLayout(
  scope: HydrationScope,
  queries: readonly QueryRef[],
) {
  for (const { queryKey } of queries) {
    scope.claimed.add(hashKey(queryKey));
  }
}

/**
 * The state one boundary hands to the browser. A layout's boundary passes the
 * queries it claimed as `own`; a page's boundary passes nothing.
 */
export function dehydrateBoundary(
  queryClient: QueryClient,
  scope: HydrationScope,
  own: readonly QueryRef[] = [],
): DehydratedState {
  const ownHashes = new Set(own.map(({ queryKey }) => hashKey(queryKey)));
  const mayDehydrate =
    queryClient.getDefaultOptions().dehydrate?.shouldDehydrateQuery ??
    defaultShouldDehydrateQuery;

  const state = dehydrate(queryClient, {
    shouldDehydrateQuery: (query) =>
      (ownHashes.has(query.queryHash) ||
        (!scope.claimed.has(query.queryHash) &&
          !scope.sent.has(query.queryHash))) &&
      mayDehydrate(query),
  });

  for (const query of state.queries) {
    scope.sent.add(query.queryHash);
  }

  return state;
}
