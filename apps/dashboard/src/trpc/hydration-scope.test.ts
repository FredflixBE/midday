import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  claimForLayout,
  createHydrationScope,
  dehydrateBoundary,
} from "./hydration-scope";

const me = { queryKey: ["user", "me"] };
const team = { queryKey: ["team", "current"] };
const isDeveloper = { queryKey: ["admin", "isDeveloper"] };
const rows = { queryKey: ["transactions", "get"] };
const tags = { queryKey: ["tags", "get"] };

function cacheWith(...queries: { queryKey: string[] }[]) {
  const queryClient = new QueryClient();
  for (const { queryKey } of queries) {
    queryClient.setQueryData(queryKey, queryKey.join("."));
  }
  return queryClient;
}

const sent = (state: ReturnType<typeof dehydrateBoundary>) =>
  state.queries.map((query) => query.queryKey.join(".")).sort();

describe("dehydrateBoundary", () => {
  test("a page rendered before its layout's boundary leaves the layout's queries to the layout", () => {
    const queryClient = cacheWith(me, team, rows, tags);
    const scope = createHydrationScope();
    claimForLayout(scope, [me, team]);

    expect(sent(dehydrateBoundary(queryClient, scope))).toEqual([
      "tags.get",
      "transactions.get",
    ]);
    expect(sent(dehydrateBoundary(queryClient, scope, [me, team]))).toEqual([
      "team.current",
      "user.me",
    ]);
  });

  test("a layout's boundary that renders first carries the page's queries once", () => {
    const queryClient = cacheWith(me, rows);
    const scope = createHydrationScope();
    claimForLayout(scope, [me]);

    expect(sent(dehydrateBoundary(queryClient, scope, [me]))).toEqual([
      "transactions.get",
      "user.me",
    ]);
    expect(sent(dehydrateBoundary(queryClient, scope))).toEqual([]);
  });

  test("nested layouts each send their own claims, whichever renders first", () => {
    const queryClient = cacheWith(me, isDeveloper);
    const scope = createHydrationScope();
    claimForLayout(scope, [me]);
    claimForLayout(scope, [isDeveloper]);

    expect(sent(dehydrateBoundary(queryClient, scope, [isDeveloper]))).toEqual([
      "admin.isDeveloper",
    ]);
    expect(sent(dehydrateBoundary(queryClient, scope, [me]))).toEqual([
      "user.me",
    ]);
  });

  test("a layout's claim is sent even when another boundary sent it first", () => {
    const queryClient = cacheWith(me);
    const scope = createHydrationScope();

    // The page dehydrated before the layout got to claim: a duplicate, never a gap.
    expect(sent(dehydrateBoundary(queryClient, scope))).toEqual(["user.me"]);
    claimForLayout(scope, [me]);
    expect(sent(dehydrateBoundary(queryClient, scope, [me]))).toEqual([
      "user.me",
    ]);
  });

  test("without a layout in the render, a page sends everything it has", () => {
    const queryClient = cacheWith(me, rows);

    expect(
      sent(dehydrateBoundary(queryClient, createHydrationScope())),
    ).toEqual(["transactions.get", "user.me"]);
  });

  test("keeps the client's own rule for which queries may be sent", () => {
    const queryClient = cacheWith(rows);
    queryClient.setDefaultOptions({
      dehydrate: { shouldDehydrateQuery: () => false },
    });

    expect(
      sent(dehydrateBoundary(queryClient, createHydrationScope())),
    ).toEqual([]);
  });
});
