import type { Metadata } from "next";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import type { SearchParams } from "nuqs";
import { Suspense } from "react";
import { ErrorFallback } from "@/components/error-fallback";
import { Inbox } from "@/components/inbox";
import { InboxConnectedEmpty } from "@/components/inbox/inbox-empty";
import { InboxGetStarted } from "@/components/inbox/inbox-get-started";
import { InboxHeader } from "@/components/inbox/inbox-header";
import { InboxViewSkeleton } from "@/components/inbox/inbox-skeleton";
import { InboxView } from "@/components/inbox/inbox-view";
import { loadInboxFilterParams } from "@/hooks/use-inbox-filter-params";
import { loadInboxParams } from "@/hooks/use-inbox-params";
import { getQueryClient, HydrateClient, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Inbox | Midday",
};

type Props = {
  searchParams: Promise<SearchParams>;
};

// The page itself renders at once, so clicking Inbox shows the skeleton instead
// of leaving the previous page on screen while the API answers. Whether to
// show the list, the empty state or the get-started screen needs that answer,
// so it is decided inside the boundary.
export default function Page(props: Props) {
  return (
    <Suspense
      fallback={
        <>
          <InboxHeader />
          <InboxViewSkeleton />
        </>
      }
    >
      <InboxContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function InboxContent(props: Props) {
  const queryClient = getQueryClient();
  const searchParams = await props.searchParams;
  const filter = loadInboxFilterParams(searchParams);
  const params = loadInboxParams(searchParams);

  // Fetch inbox data and accounts in parallel.
  // Wrapped in catch so a transient failure doesn't blank the page.
  const [data, accounts] = await Promise.all([
    queryClient
      .fetchInfiniteQuery(
        trpc.inbox.get.infiniteQueryOptions(
          {
            order: params.inboxOrder,
            sort: params.inboxSort,
            ...filter,
            tab: filter.tab ?? "all",
          },
          {
            getNextPageParam: ({ meta }) => meta?.cursor,
          },
        ),
      )
      .catch(() => null),
    queryClient
      .fetchQuery(trpc.inboxAccounts.get.queryOptions())
      .catch(() => null),
  ]);

  const hasInboxItems = (data?.pages?.[0]?.data?.length ?? 0) > 0;
  const hasConnectedAccounts = accounts && accounts.length > 0;
  // Exclude 'tab' from filter check since it's a navigation param, not a filter
  const hasFilter = Object.entries(filter).some(
    ([key, value]) => key !== "tab" && value !== null,
  );
  const isAllTab = !filter.tab || filter.tab === "all";

  // No accounts and no items (and no filter) -> show get started
  if (!hasConnectedAccounts && !hasInboxItems && !hasFilter) {
    return <InboxGetStarted />;
  }

  // Accounts exist and have been synced, but no items (and no filter, on "all" tab) -> show connected empty
  const hasSyncedAccounts = accounts?.some((a) => a.lastAccessed !== null);

  if (
    isAllTab &&
    hasConnectedAccounts &&
    hasSyncedAccounts &&
    !hasInboxItems &&
    !hasFilter &&
    !params.connected
  ) {
    return (
      <Inbox>
        <InboxConnectedEmpty />
      </Inbox>
    );
  }

  return (
    <HydrateClient>
      <Inbox>
        <ErrorBoundary errorComponent={ErrorFallback}>
          <Suspense fallback={<InboxViewSkeleton />}>
            <InboxView />
          </Suspense>
        </ErrorBoundary>
      </Inbox>
    </HydrateClient>
  );
}
