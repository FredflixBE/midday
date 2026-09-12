#!/usr/bin/env bun
/**
 * Put back the lockfile entries `turbo prune` mangles on its way out.
 *
 * A dependency fetched from a tarball URL rather than from the registry is
 * recorded by bun as a two-element entry — the spec, then the package info:
 *
 *   "xlsx": ["xlsx@https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz", { "bin": … }],
 *
 * turbo 2.9.3 re-emits every entry in the four-element registry shape instead,
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
 * turbo 2.10.12 prunes these correctly, so this stops being needed the moment
 * the repo's turbo moves past 2.9.3 — at which point it reports "nothing to
 * repair" and can be deleted along with its two Dockerfile lines. Both
 * Dockerfiles pin `bun add -g turbo@2.9.3` precisely so that which of those
 * two behaviours a build gets is a decision and not a dist-tag lookup.
 */

/**
 * A whole entry line: indent, key, and the four-element array turbo emits,
 * with both the registry and the integrity empty. The info object is matched
 * greedily, which the `, ""],` anchor makes correct even when the object
 * contains a `}` inside a string.
 */
const MANGLED_ENTRY =
  /^(\s*)("(?:[^"\\]|\\.)*"): \[("(?:[^"\\]|\\.)*"), "", (\{.*\}), ""\](,?)$/;

/** The protocols whose two-element shape this script knows how to restore. */
const TARBALL = /^https?:\/\//;

/**
 * The version half of a `name@version` key.
 *
 * The split is on the *first* `@` after position 0, not the last: a scoped
 * name starts with one, and a tarball URL may well contain one
 * (`https://user@host/x.tgz`), so `lastIndexOf` finds the wrong boundary for
 * exactly the entries this script exists to fix.
 */
export function versionOf(quotedSpec: string): string {
  const spec = quotedSpec.slice(1, -1);
  const at = spec.indexOf("@", 1);

  return at === -1 ? "" : spec.slice(at + 1);
}

export function repair(lockfile: string): {
  text: string;
  repaired: string[];
} {
  const repaired: string[] = [];

  const text = lockfile
    .split("\n")
    .map((line) => {
      const match = line.match(MANGLED_ENTRY);

      if (!match) return line;

      const [, indent, key, spec, info, comma] = match;
      const version = versionOf(spec as string);

      // A plain registry version in this shape is an ordinary entry that
      // happens to carry no integrity, not something turbo mangled.
      if (!version.includes(":")) return line;

      // Anything else non-registry — git, `npm:` aliases, `file:` — bun
      // stores in a shape this script has never seen, so guessing at it would
      // write a lockfile that is wrong rather than merely unreadable. Stop
      // instead, and let whoever added the dependency decide.
      if (!TARBALL.test(version)) {
        throw new Error(
          `${key}: don't know how to restore a non-tarball entry (${version}). ` +
            "Teach this script that protocol's shape before depending on it.",
        );
      }

      repaired.push((key as string).slice(1, -1));

      return `${indent}${key}: [${spec}, ${info}]${comma}`;
    })
    .join("\n");

  return { text, repaired };
}

if (import.meta.main) {
  const path = process.argv[2];

  if (!path) {
    console.error(
      "usage: bun scripts/repair-pruned-lockfile.ts <path-to-bun.lock>",
    );
    process.exit(1);
  }

  const { text, repaired } = repair(await Bun.file(path).text());

  if (repaired.length === 0) {
    console.log(`${path}: nothing to repair`);
  } else {
    await Bun.write(path, text);
    console.log(`${path}: restored ${repaired.length}: ${repaired.join(", ")}`);
  }
}
