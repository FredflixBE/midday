import { describe, expect, test } from "bun:test";
import { MAX_CHUNK_BYTES, measureJobsBundle } from "./bundle-size";

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

const measurement = await measureJobsBundle();

describe("the jobs bundle", () => {
  test("has entry points at all", () => {
    // Without this the ceiling below passes an empty bundle, and a guard that
    // cannot fail is worse than no guard.
    expect(measurement.entryPoints).toBeGreaterThan(20);
    expect(measurement.outputs.length).toBeGreaterThan(0);
  });

  test("keeps every chunk under the stack-formatting ceiling", () => {
    const largest = measurement.outputs[0]!;

    if (largest.bytes > MAX_CHUNK_BYTES) {
      const culprits = measurement
        .packagesIn(largest.file)
        .slice(0, 5)
        .map((pkg) => `  ${mb(pkg.bytes)}  ${pkg.name}`)
        .join("\n");

      throw new Error(
        [
          `${largest.file} is ${mb(largest.bytes)}, over the ${mb(MAX_CHUNK_BYTES)} ceiling.`,
          "",
          "The dev worker resolves every stack frame in this chunk against its",
          "source map, and that cost scales with the chunk. What is in it:",
          culprits,
          "",
          "Usually one dependency, and usually an umbrella package that imports",
          "a whole product family when the code needs one client of it.",
        ].join("\n"),
      );
    }

    expect(largest.bytes).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  });
});
