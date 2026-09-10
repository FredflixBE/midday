import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./concurrency";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  test("returns results in input order, not completion order", async () => {
    const results = await mapWithConcurrency(
      [30, 10, 20],
      2,
      async (delay) => {
        await sleep(delay);
        return delay;
      },
    );

    expect(results).toEqual([30, 10, 20]);
  });

  test("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
    });

    expect(peak).toBe(2);
  });

  test("runs everything", async () => {
    const seen: number[] = [];

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      await sleep(1);
      seen.push(item);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("does nothing with an empty list", async () => {
    expect(await mapWithConcurrency([], 2, async () => 1)).toEqual([]);
  });
});
