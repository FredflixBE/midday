import { describe, expect, test } from "bun:test";
import {
  type Chunk,
  MAX_SOURCE_MAP_BYTES,
  measureJobsBundle,
} from "./bundle-size";

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

const measurement = await measureJobsBundle();

/**
 * What the failure has to say, since knowing a chunk is too big is not the
 * useful part — knowing which dependency made it that way is. It is almost
 * always one, and almost always an umbrella package that imports a whole
 * product family where the code needed a single client of it.
 */
function explain(chunk: Chunk): string {
  return [
    `${chunk.file} has a ${mb(chunk.sourceMapBytes)} source map, over the ${mb(MAX_SOURCE_MAP_BYTES)} ceiling.`,
    "The dev worker parses that map for every stack frame in the chunk.",
    "What is in it:",
    ...chunk.packages
      .slice(0, 5)
      .map((pkg) => `  ${mb(pkg.bytes)}  ${pkg.name}`),
  ].join("\n");
}

describe("the jobs bundle", () => {
  test("is measured at all", () => {
    // A ceiling over an empty bundle is a guard that cannot fail, so this is
    // the guard on the guard.
    expect(measurement.entryPointCount).toBeGreaterThan(0);
    expect(measurement.chunks.length).toBeGreaterThan(0);
  });

  test("keeps every source map under the stack-formatting ceiling", () => {
    const heaviest = measurement.chunks[0];

    expect(
      heaviest && heaviest.sourceMapBytes > MAX_SOURCE_MAP_BYTES
        ? explain(heaviest)
        : "under the ceiling",
    ).toBe("under the ceiling");
  });
});
