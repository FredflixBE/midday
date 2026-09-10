import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import config from "../trigger.config";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The most a single emitted chunk may weigh, in bytes.
 *
 * This is not a budget for the deployed size — nobody minds a large bundle on
 * disk. It is a ceiling on what one stack frame costs to format.
 *
 * The dev worker resolves every frame of every error whose `.stack` is read
 * against the chunk's source map, and a map runs a little under twice its
 * chunk. Before FF-1487 the largest chunk was 30 MB and one frame lookup
 * allocated 582 MB, which killed a warm executor at around 210 MB of heap.
 * Removing one umbrella dependency took the same chunk to under 5 MB and the
 * same lookup to 133 MB.
 *
 * 12 MB is roughly two and a half times what the largest chunk weighs today,
 * so an honest new dependency does not trip it, and a quarter of what the
 * regression weighed, so that class of mistake cannot slip past.
 */
export const MAX_CHUNK_BYTES = 12 * 1024 * 1024;

export type BundleMeasurement = {
  entryPoints: number;
  outputs: { file: string; bytes: number }[];
  /** Bytes contributed to `file` by each npm package, largest first. */
  packagesIn: (file: string) => { name: string; bytes: number }[];
};

function packageOf(inputPath: string): string {
  const match = inputPath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return match?.[1] ?? "(workspace)";
}

/**
 * Build the task entry points the way Trigger.dev does, and report what came
 * out.
 *
 * esbuild rather than the Trigger CLI because the CLI needs a project token
 * and a network call to build, and this has to run on any checkout. It is
 * close enough to be worth trusting: measured against the same tree, this
 * reports 4.8 MB where the CLI reports 5.0, and 30.1 MB where it reports 30.4.
 *
 * Nothing is written to disk — only the metafile is read.
 */
export async function measureJobsBundle(): Promise<BundleMeasurement> {
  const entryPoints = globSync("src/tasks/**/*.ts", { cwd: PACKAGE_ROOT }).map(
    (file) => resolve(PACKAGE_ROOT, file),
  );

  const result = await build({
    entryPoints,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    outdir: resolve(PACKAGE_ROOT, ".bundle-size"),
    // The same list the real build is given, so a package left out there is
    // left out here.
    external: config.build?.external ?? [],
    metafile: true,
    write: false,
    logLevel: "silent",
  });

  const outputs = Object.entries(result.metafile.outputs)
    .filter(([file]) => file.endsWith(".js"))
    .map(([file, meta]) => ({ file, bytes: meta.bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    entryPoints: entryPoints.length,
    outputs,
    packagesIn: (file) => {
      const inputs = result.metafile.outputs[file]?.inputs ?? {};
      const totals = new Map<string, number>();

      for (const [input, meta] of Object.entries(inputs)) {
        const name = packageOf(input);
        totals.set(name, (totals.get(name) ?? 0) + meta.bytesInOutput);
      }

      return [...totals]
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((a, b) => b.bytes - a.bytes);
    },
  };
}
