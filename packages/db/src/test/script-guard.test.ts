/**
 * A script cannot write to production without saying so (FF-1683).
 *
 * The rule is that a script is assumed to write. What is tested here is mostly
 * the refusals, because the failure this guards against is not an exception —
 * it is a script that ran, quietly, against the real books.
 *
 * The last test is the one that keeps this true next month: it reads every
 * script in the repository and fails if one of them can reach a database by a
 * route the guard does not sit on.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  announcement,
  declaredEnvironment,
  describeTarget,
  guardScriptConnection,
  isScriptEntry,
  needsConfirmation,
  resetScriptGuard,
} from "../script-guard";

const PROD =
  "postgresql://postgres.pnkbnmghhvsnexrxqilm:hunter2@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
const DIRECT =
  "postgresql://postgres:hunter2@db.pnkbnmghhvsnexrxqilm.supabase.co:5432/postgres";
const LOCAL = "postgres://postgres:postgres@localhost:5433/midday_test";

const SCRIPT = ["bun", "/repo/packages/jobs/scripts/link-suppliers.ts"];
const NOT_A_SCRIPT = ["bun", "/repo/apps/api/src/index.ts"];

function guard(
  connection: string | undefined,
  env: NodeJS.ProcessEnv,
  argv = SCRIPT,
) {
  return () => guardScriptConnection(connection, { argv, env });
}

beforeEach(() => resetScriptGuard());

describe("what the marker says", () => {
  test("names the environment, and accepts the obvious short forms", () => {
    expect(declaredEnvironment({ DATABASE_ENVIRONMENT: "production" })).toBe(
      "production",
    );
    expect(declaredEnvironment({ DATABASE_ENVIRONMENT: "PROD" })).toBe(
      "production",
    );
    expect(declaredEnvironment({ DATABASE_ENVIRONMENT: " dev " })).toBe(
      "development",
    );
    expect(declaredEnvironment({ DATABASE_ENVIRONMENT: "ci" })).toBe("test");
  });

  test("unset is unknown, not safe", () => {
    expect(declaredEnvironment({})).toBe("unknown");
    expect(declaredEnvironment({ DATABASE_ENVIRONMENT: "" })).toBe("unknown");
  });

  test("a value nobody recognises is unknown rather than a guess", () => {
    expect(declaredEnvironment({ DATABASE_ENVIRONMENT: "frankfurt" })).toBe(
      "unknown",
    );
  });
});

describe("what it reports about the target", () => {
  test("reads the Supabase project from a session pooler connection", () => {
    const target = describeTarget(PROD, { DATABASE_ENVIRONMENT: "production" });
    expect(target.project).toBe("pnkbnmghhvsnexrxqilm");
    expect(target.host).toBe("aws-0-eu-central-1.pooler.supabase.com");
    expect(target.database).toBe("postgres");
  });

  test("and from a direct connection, where it lives in the host", () => {
    expect(describeTarget(DIRECT, {}).project).toBe("pnkbnmghhvsnexrxqilm");
  });

  test("never repeats the password", () => {
    const target = describeTarget(PROD, { DATABASE_ENVIRONMENT: "production" });
    expect(JSON.stringify(target)).not.toContain("hunter2");
    expect(announcement(target, false)).not.toContain("hunter2");
  });

  test("survives a connection string it cannot parse", () => {
    const target = describeTarget("not a url", {});
    expect(target.host).toBeNull();
    expect(target.environment).toBe("unknown");
  });
});

describe("who needs to confirm", () => {
  test("production does", () => {
    expect(
      needsConfirmation(describeTarget(PROD, { DATABASE_ENVIRONMENT: "prod" })),
    ).toBe(true);
  });

  test("an unlabelled remote database does, because it might be", () => {
    expect(needsConfirmation(describeTarget(PROD, {}))).toBe(true);
  });

  test("a labelled development database does not", () => {
    expect(
      needsConfirmation(describeTarget(PROD, { DATABASE_ENVIRONMENT: "dev" })),
    ).toBe(false);
  });

  test("a database on this machine never does, labelled or not", () => {
    expect(needsConfirmation(describeTarget(LOCAL, {}))).toBe(false);
    expect(
      needsConfirmation(
        describeTarget(LOCAL, { DATABASE_ENVIRONMENT: "production" }),
      ),
    ).toBe(false);
  });
});

describe("the guard itself", () => {
  test("refuses a script that has not said it only reads", () => {
    expect(guard(PROD, { DATABASE_ENVIRONMENT: "production" })).toThrow(
      /Refusing to run a script that may write against production/,
    );
  });

  test("the refusal names what it saw, so it is one line to fix", () => {
    expect(guard(PROD, { DATABASE_ENVIRONMENT: "production" })).toThrow(
      /pnkbnmghhvsnexrxqilm/,
    );
    expect(guard(PROD, { DATABASE_ENVIRONMENT: "production" })).toThrow(
      /aws-0-eu-central-1\.pooler\.supabase\.com/,
    );
  });

  test("refuses an unlabelled database, and says what to set", () => {
    expect(guard(PROD, {})).toThrow(/does not say which environment it is/);
    expect(guard(PROD, {})).toThrow(/DATABASE_ENVIRONMENT/);
  });

  test("lets a connection opened read-only through against production", () => {
    expect(() =>
      guardScriptConnection(PROD, {
        readOnly: true,
        argv: SCRIPT,
        env: { DATABASE_ENVIRONMENT: "production" },
      }),
    ).not.toThrow();
  });

  test("read-only is a property of the call, not of the process", () => {
    // A writing script that imports a helper out of a read-only one must not
    // inherit its exemption. This is the whole reason it is an argument.
    guardScriptConnection(PROD, {
      readOnly: true,
      argv: SCRIPT,
      env: { DATABASE_ENVIRONMENT: "production" },
    });

    expect(guard(PROD, { DATABASE_ENVIRONMENT: "production" })).toThrow(
      /Refusing/,
    );
  });

  test("lets a confirmed write through, and only on exactly true", () => {
    expect(
      guard(PROD, {
        DATABASE_ENVIRONMENT: "production",
        CONFIRM_DATABASE_PROD: "true",
      }),
    ).not.toThrow();

    expect(
      guard(PROD, {
        DATABASE_ENVIRONMENT: "production",
        CONFIRM_DATABASE_PROD: "yes",
      }),
    ).toThrow();
  });

  test("lets development and the test database through untouched", () => {
    expect(guard(PROD, { DATABASE_ENVIRONMENT: "development" })).not.toThrow();
    resetScriptGuard();
    expect(guard(LOCAL, {})).not.toThrow();
  });

  test("is inert when the process is not a script", () => {
    expect(
      guard(PROD, { DATABASE_ENVIRONMENT: "production" }, NOT_A_SCRIPT),
    ).not.toThrow();
  });

  test("announces a second, different target rather than only the first", () => {
    const said: string[] = [];
    const original = console.error;
    console.error = (line: string) => said.push(line);

    try {
      const env = { DATABASE_ENVIRONMENT: "development" };
      guardScriptConnection(PROD, { argv: SCRIPT, env });
      guardScriptConnection(PROD, { argv: SCRIPT, env });
      guardScriptConnection(LOCAL, { argv: SCRIPT, env });
    } finally {
      console.error = original;
    }

    expect(said).toHaveLength(2);
    expect(said[1]).toContain("localhost");
  });

  test("recognises a script entry point by where the file lives", () => {
    expect(isScriptEntry(SCRIPT)).toBe(true);
    expect(
      isScriptEntry(["bun", "/repo/packages/db/src/scripts/stamp.ts"]),
    ).toBe(true);
    expect(isScriptEntry(NOT_A_SCRIPT)).toBe(false);
    expect(isScriptEntry(["bun"])).toBe(false);
  });

  test("still recognises one run by a bare filename from inside the directory", () => {
    const cwd = process.cwd();
    process.chdir(join(repositoryRoot(), "packages/jobs/scripts"));

    try {
      expect(isScriptEntry(["bun", "link-suppliers.ts"])).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

/** Walks up from wherever the runner was started until `turbo.json` appears. */
function repositoryRoot(): string {
  let dir = process.cwd();

  while (!existsSync(join(dir, "turbo.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No turbo.json above ${process.cwd()}`);
    dir = parent;
  }

  return dir;
}

describe("no script can reach a database around the guard", () => {
  const root = repositoryRoot();

  /**
   * Every `scripts/` directory in the repository, because `isScriptEntry`
   * fires on all of them and the guard is only as good as its coverage. The
   * first version of this test knew about two, and the two it did not know
   * about held a script that upserts institutions.
   */
  const directories = [
    "packages/db/src/scripts",
    "packages/jobs/scripts",
    "packages/banking/scripts",
    "packages/yuki/scripts",
  ].map((relative) => join(root, relative));

  /**
   * Scripts that reach a database only through `connectDb` or `createJobDb`
   * are covered by their author doing nothing — those call the guard. These
   * two routes are not:
   *
   * - opening a `pg` client or pool directly;
   * - importing the module-scope `db` or `pool` out of `@midday/db/client`,
   *   which is built at import time and asks nobody anything.
   *
   * Either one has to call `guardScriptConnection` by hand, and this is what
   * makes forgetting a failing test rather than a silent write to the books.
   */
  function reachesDatabaseUnguarded(source: string): boolean {
    const ownConnection = /new (Client|Pool)\s*\(/.test(source);
    const moduleScopeDb =
      /import\s*\{[^}]*\b(db|pool)\b[^}]*\}\s*from\s*["'][^"']*db\/client["']/.test(
        source,
      );

    return ownConnection || moduleScopeDb;
  }

  /**
   * The test-database scripts, named rather than pattern-matched. They refuse
   * anything that is not `localhost` before they connect, which is a stricter
   * rule than this one — and a list of filenames cannot be tripped by a
   * comment the way a regex over the source could.
   */
  const EXEMPT = new Set([
    "apply-sql.ts",
    "apply-policies.ts",
    "setup-test-db.ts",
    "verify-migrations.ts",
  ]);

  const files = directories.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, source: readFileSync(join(dir, name), "utf8") })),
  );

  test("there are scripts to check, in every directory", () => {
    expect(files.length).toBeGreaterThan(30);
    for (const dir of directories)
      expect(readdirSync(dir).length).toBeGreaterThan(0);
  });

  for (const { name, source } of files) {
    if (EXEMPT.has(name)) continue;
    if (!reachesDatabaseUnguarded(source)) continue;

    test(`${name} opens its own connection and calls the guard`, () => {
      expect(source).toContain("guardScriptConnection(");
    });
  }
});
