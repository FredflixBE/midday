/**
 * The review badge counts on the server, but the mutations that change the
 * review queue invalidate the transactions list, not the count (FF-1713).
 * Keys have the shape tRPC gives them.
 */
import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { followInvalidations } from "./use-review-count";

const listKey = [["transactions", "get"], { type: "infinite" }];
const countKey = [["transactions", "getReviewCount"], { type: "query" }];

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    [
      ["transactions", "get"],
      { input: { fulfilled: true, exported: false }, type: "infinite" },
    ],
    { pages: [], pageParams: [] },
  );
  queryClient.setQueryData(
    [["transactions", "getById"], { input: { id: "t1" }, type: "query" }],
    {},
  );
  queryClient.setQueryData(countKey, 19);
  const stop = followInvalidations(queryClient, listKey, countKey);
  const countIsStale = () =>
    queryClient.getQueryState(countKey)?.isInvalidated ?? false;

  return { queryClient, stop, countIsStale };
}

test("invalidating the transactions list invalidates the review count", async () => {
  const { queryClient, stop, countIsStale } = setup();

  expect(countIsStale()).toBe(false);
  await queryClient.invalidateQueries({ queryKey: listKey });
  expect(countIsStale()).toBe(true);

  stop();
});

test("invalidating another transactions query leaves the count alone", async () => {
  const { queryClient, stop, countIsStale } = setup();

  await queryClient.invalidateQueries({
    queryKey: [["transactions", "getById"]],
  });
  expect(countIsStale()).toBe(false);

  stop();
});

test("after unsubscribing, the count no longer follows", async () => {
  const { queryClient, stop, countIsStale } = setup();

  stop();
  await queryClient.invalidateQueries({ queryKey: listKey });
  expect(countIsStale()).toBe(false);
});
