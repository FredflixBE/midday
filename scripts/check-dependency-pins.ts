#!/usr/bin/env bun
/**
 * Fail if any package in this repo asks npm what version it wants.
 *
 * `"latest"` and `"*"` are not versions, they are questions asked fresh on
 * every install. `bun.lock` writes down the answer, so a frozen install starts
 * failing the moment the answer changes — on every branch at once, with an
 * error that names no dependency and points at whichever pull request you
 * happen to be looking at. It has cost this repo two afternoons.
 *
 * It also spreads. The ticket that removed these counted nine declarations
 * when it was written and ten by the time it was worked, because each new
 * package copies its devDependencies from a neighbour. Nothing but this stops
 * the eleventh arriving.
 *
 * This is a CI step rather than a `bun test` on purpose: turbo caches tests
 * per package, so a guard living in one package would be replayed from cache —
 * and stay silent — exactly when a *different*, brand new package is the one
 * introducing the floating spec.
 */
import { relative } from "node:path";

/**
 * Specs that resolve to whatever the registry is serving at install time.
 *
 * Ranges — `^4.1.0`, `~2.3`, `>=1` — are a smaller version of the same
 * problem and are deliberately not here: this repo still uses them widely,
 * and a check that failed on them would fail on everything. What it catches
 * is the spec that pins nothing at all.
 */
const FLOATING = new Set(["latest", "*", "x", "X", ""]);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Every manifest this repo owns: the root one, plus whatever its `workspaces`
 * globs match.
 *
 * Reading the set from `workspaces` rather than walking the tree is what
 * makes this self-maintaining — a new workspace glob is covered the day it is
 * added — and it is also what keeps the check off manifests we did not write,
 * which a walk would have to be taught to skip one build directory at a time.
 */
async function manifests(): Promise<string[]> {
  const root = `${ROOT}package.json`;
  const { workspaces } = await Bun.file(root).json();

  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error(
      "The root package.json declares no workspaces, so this check would only ever read one file.",
    );
  }

  const found = await Promise.all(
    workspaces.map(async (pattern: string) => {
      const glob = new Bun.Glob(`${pattern}/package.json`);
      const matches = await Array.fromAsync(glob.scan({ cwd: ROOT }));

      // A glob that matches nothing would make this pass by having nothing to
      // check, which is the one way a guard like this fails silently.
      if (matches.length === 0) {
        throw new Error(`Workspace glob "${pattern}" matched no package.json.`);
      }

      return matches.map((match) => `${ROOT}${match}`);
    }),
  );

  return [root, ...found.flat()];
}

type Violation = { file: string; field: string; name: string; spec: string };

async function violations(file: string): Promise<Violation[]> {
  const manifest = await Bun.file(file).json();
  const found: Violation[] = [];

  // The root `catalog` is a dependency declaration like any other: every
  // `"catalog:"` in the workspaces resolves through it.
  for (const field of [...DEPENDENCY_FIELDS, "catalog"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && FLOATING.has(spec.trim())) {
        found.push({ file: relative(ROOT, file), field, name, spec });
      }
    }
  }

  return found;
}

const files = await manifests();
const found = (await Promise.all(files.map(violations))).flat();

if (found.length === 0) {
  console.log(
    `Checked ${files.length} package.json files: every dependency names a version.`,
  );
  process.exit(0);
}

console.error("Floating dependency specs found:\n");

for (const { file, field, name, spec } of found) {
  console.error(`  ${file} → ${field}.${name} = "${spec}"`);
}

console.error(
  "\nReplace each with the exact version it resolves to today, then run `bun install` and commit bun.lock.\n" +
    "A spec that pins nothing is not a decision: it lets an install change what the code is built against without anyone choosing it.",
);

process.exit(1);
