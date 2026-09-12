#!/usr/bin/env bun
/**
 * Put back the lockfile entries `turbo prune` mangles on its way out.
 *
 * A dependency resolved from a tarball URL rather than from the registry is
 * recorded by bun as a two-element entry — the spec, then the package info:
 *
 *   "xlsx": ["xlsx@https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz", { "bin": … }],
 *
 * `turbo prune` re-emits every entry in the four-element registry shape,
 * padding the registry and integrity fields it has no values for:
 *
 *   "xlsx": ["xlsx@https://cdn.sheetjs.com/…tgz", "", { "bin": … }, ""],
 *
 * bun cannot read that back. It fails with `InvalidPackageInfo: Expected an
 * object`, warns `Ignoring lockfile`, and resolves every dependency afresh
 * from the registry — so the image installs whatever npm serves at build time
 * rather than what the lockfile pins, silently, on every build. Under
 * `--frozen-lockfile` it fails the build outright instead.
 *
 * This rewrites those entries into the shape bun wrote them in. Only entries
 * whose version is not a plain registry version are touched; everything else
 * is copied through byte for byte.
 *
 * Reproduced with turbo 2.9.3 and 2.10.12 and bun 1.3.10/1.3.11. When turbo
 * learns to prune non-registry entries correctly this stops matching anything
 * and can go; the `bun install --frozen-lockfile` that follows it in both
 * Dockerfiles is what proves it is still needed.
 */

/**
 * A whole entry line: indent, key, and the four-element array turbo emits,
 * with both the registry and the integrity empty. The info object is matched
 * greedily up to the trailing `, ""]` so that nested braces survive.
 */
const MANGLED_ENTRY =
  /^(\s*)("(?:[^"\\]|\\.)*"): \[("(?:[^"\\]|\\.)*"), "", (\{.*\}), ""\](,?)$/;

/**
 * `name@version`, where a registry version is a bare `1.2.3` and anything bun
 * had to fetch from elsewhere carries a protocol — `https:`, `github:`, `file:`.
 * The leading `@` of a scoped name is skipped, so `@types/bun@1.4.2` splits at
 * the second one.
 */
function isNonRegistrySpec(quotedSpec: string): boolean {
  const spec = quotedSpec.slice(1, -1);
  const at = spec.lastIndexOf("@");

  return at > 0 && spec.slice(at + 1).includes(":");
}

function repair(lockfile: string): { text: string; repaired: string[] } {
  const repaired: string[] = [];

  const text = lockfile
    .split("\n")
    .map((line) => {
      const match = line.match(MANGLED_ENTRY);

      if (!match) return line;

      const [, indent, key, spec, info, comma] = match;

      if (!isNonRegistrySpec(spec!)) return line;

      repaired.push(key!.slice(1, -1));

      return `${indent}${key}: [${spec}, ${info}]${comma}`;
    })
    .join("\n");

  return { text, repaired };
}

const path = process.argv[2];

if (!path) {
  console.error(
    "usage: bun scripts/repair-pruned-lockfile.ts <path-to-bun.lock>",
  );
  process.exit(1);
}

const before = await Bun.file(path).text();
const { text, repaired } = repair(before);

if (repaired.length === 0) {
  console.log(`${path}: nothing to repair`);
} else {
  await Bun.write(path, text);
  console.log(
    `${path}: repaired ${repaired.length} entry/entries: ${repaired.join(", ")}`,
  );
}
