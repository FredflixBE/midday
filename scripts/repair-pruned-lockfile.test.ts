import { describe, expect, test } from "bun:test";
import { repair, versionOf } from "./repair-pruned-lockfile";

/**
 * This script sits on the critical path of both production image builds: if
 * it gets a line wrong, the lockfile it writes is what the shipping container
 * installs from. Nothing else exercises it — `scripts/` is outside the
 * workspaces, so neither `turbo typecheck` nor `turbo test` reaches it, which
 * is why these run as their own CI step.
 */

/** The real line, as turbo 2.9.3 emits it and as bun wrote it. */
const MANGLED = `    "xlsx": ["xlsx@https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz", "", { "bin": { "xlsx": "./bin/xlsx.njs" } }, ""],`;
const RESTORED = `    "xlsx": ["xlsx@https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz", { "bin": { "xlsx": "./bin/xlsx.njs" } }],`;

describe("versionOf", () => {
  test("splits on the first @, so a scoped name keeps its own", () => {
    expect(versionOf('"@types/bun@1.4.2"')).toBe("1.4.2");
  });

  test("keeps a URL whole, @ signs and all", () => {
    // lastIndexOf would cut this at the host and call it a registry version,
    // leaving the one kind of entry this script exists to fix unrepaired.
    expect(versionOf('"pkg@https://user@host.example/a.tgz"')).toBe(
      "https://user@host.example/a.tgz",
    );
  });
});

describe("repair", () => {
  test("restores the two-element shape bun wrote", () => {
    const { text, repaired } = repair(MANGLED);

    expect(text).toBe(RESTORED);
    expect(repaired).toEqual(["xlsx"]);
  });

  test("leaves an ordinary registry entry alone", () => {
    const line = `    "@types/bun": ["@types/bun@1.4.2", "", { "dependencies": { "bun-types": "1.4.2" } }, "sha512-abc=="],`;

    expect(repair(line)).toEqual({ text: line, repaired: [] });
  });

  test("leaves a registry entry that happens to carry no integrity alone", () => {
    const line = `    "thing": ["thing@1.0.0", "", { "bin": { "thing": "./t.js" } }, ""],`;

    expect(repair(line)).toEqual({ text: line, repaired: [] });
  });

  test("refuses a non-tarball protocol rather than guessing its shape", () => {
    const line = `    "dep": ["dep@github:owner/repo#abc123", "", { "bin": {} }, ""],`;

    expect(() => repair(line)).toThrow(/non-tarball/);
  });

  test("survives a closing brace inside a string value", () => {
    const line = `    "odd": ["odd@https://e.com/a.tgz", "", { "bin": { "odd": "./}.js" } }, ""],`;

    expect(repair(line).text).toBe(
      `    "odd": ["odd@https://e.com/a.tgz", { "bin": { "odd": "./}.js" } }],`,
    );
  });

  test("keeps every other line byte for byte, and the trailing comma", () => {
    const before = `{\n  "lockfileVersion": 1,\n  "packages": {\n${MANGLED}\n  }\n}\n`;
    const after = `{\n  "lockfileVersion": 1,\n  "packages": {\n${RESTORED}\n  }\n}\n`;

    expect(repair(before).text).toBe(after);
  });

  test("is idempotent — a repaired lockfile has nothing left to repair", () => {
    const once = repair(MANGLED);

    expect(repair(once.text)).toEqual({ text: once.text, repaired: [] });
  });
});
