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
 * disk. It is a ceiling on what one stack frame costs to format, because the
 * dev worker resolves every frame of every error whose `.stack` is read
 * against the source map of the chunk that frame lives in.
 *
 * Two points were measured for FF-1487: a 5 MB chunk cost 133 MB of heap per
 * frame and the run survived; a 30 MB chunk cost 582 MB and killed a warm
 * executor that was already holding about 210 MB. Straight through those two
 * points is roughly 18 MB of heap per MB of chunk, plus 45 MB fixed — which
 * puts 8 MB at about 186 MB a frame.
 *
 * That is the reasoning, and it is an extrapolation from two points rather
 * than a law. So the ceiling sits near the end of the range that is known to
 * work rather than in the middle of the part that isn't: 8 MB is two thirds
 * more than the largest chunk today, and a quarter of what the regression
 * weighed. Raising it is a one-line change; the point is that someone decides
 * to, having seen which dependency asked.
 */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

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
