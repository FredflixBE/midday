import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import config from "../trigger.config";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The most a single source map may weigh, in bytes.
 *
 * This is not a budget for the deployed size — nobody minds a large bundle on
 * disk. It is a ceiling on what one stack frame costs to format. The dev
 * worker resolves every frame of every error whose `.stack` is read against
 * the source map of the chunk that frame lives in, which means reading that
 * file and parsing it.
 *
 * Two points were measured for FF-1487: an 8.4 MB map cost 133 MB of heap per
 * frame and the run survived; a 50.4 MB map cost 582 MB and killed a warm
 * executor that was already holding about 210 MB. Straight through those two
 * points is roughly 11 MB of heap per MB of map, plus 43 MB fixed, which puts
 * 210 MB at a map of about 15.6 MB.
 *
 * That is the reasoning, and it is an extrapolation from two points rather
 * than a law. So the ceiling sits at the end of the range that is known to
 * work rather than in the middle of the part that isn't: 14 MB is two thirds
 * more than the largest map today, and well under what killed the worker.
 * Raising it is a one-line change; the point is that someone decides to,
 * having seen which dependency asked.
 */
export const MAX_SOURCE_MAP_BYTES = 14 * 1024 * 1024;

export type Chunk = {
  file: string;
  bytes: number;
  sourceMapBytes: number;
  /** Bytes contributed by each npm package, largest first. */
  packages: { name: string; bytes: number }[];
};

export type BundleMeasurement = {
  entryPointCount: number;
  /** Emitted chunks, heaviest source map first. */
  chunks: Chunk[];
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
 * close enough to be worth trusting: measured against the same tree the
 * largest source map here is 8.4 MB and the CLI's is 8.4 MB, and with the
 * dependency FF-1487 removed put back, 51.2 MB against the CLI's 50.4 MB.
 *
 * Both the task directories and the externals are read from the real config,
 * so neither can drift into measuring something the deployed bundle is not.
 * Nothing is written to disk — only the metafile is read.
 */
export async function measureJobsBundle(): Promise<BundleMeasurement> {
  const entryPoints = (config.dirs ?? [])
    .flatMap((dir) => globSync(`${dir}/**/*.ts`, { cwd: PACKAGE_ROOT }))
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => resolve(PACKAGE_ROOT, file));

  const result = await build({
    entryPoints,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    outdir: resolve(PACKAGE_ROOT, ".bundle-size"),
    // The maps are the artifact being measured, not a side effect of it.
    sourcemap: true,
    external: config.build?.external ?? [],
    metafile: true,
    write: false,
    logLevel: "silent",
  });

  const outputs = result.metafile.outputs;

  const chunks: Chunk[] = Object.entries(outputs)
    .filter(([file]) => file.endsWith(".js"))
    .map(([file, meta]) => {
      const totals = new Map<string, number>();

      for (const [input, inputMeta] of Object.entries(meta.inputs)) {
        const name = packageOf(input);
        totals.set(name, (totals.get(name) ?? 0) + inputMeta.bytesInOutput);
      }

      return {
        file,
        bytes: meta.bytes,
        sourceMapBytes: outputs[`${file}.map`]?.bytes ?? 0,
        packages: [...totals]
          .map(([name, bytes]) => ({ name, bytes }))
          .sort((a, b) => b.bytes - a.bytes),
      };
    })
    .sort((a, b) => b.sourceMapBytes - a.sourceMapBytes);

  return { entryPointCount: entryPoints.length, chunks };
}
