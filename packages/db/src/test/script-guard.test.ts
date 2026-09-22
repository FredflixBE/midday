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
  readOnlyScript,
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

  test("lets a declared read-only script through against production", () => {
    readOnlyScript();
    expect(guard(PROD, { DATABASE_ENVIRONMENT: "production" })).not.toThrow();
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

  test("recognises a script entry point by where the file lives", () => {
    expect(isScriptEntry(SCRIPT)).toBe(true);
    expect(
      isScriptEntry(["bun", "/repo/packages/db/src/scripts/stamp.ts"]),
    ).toBe(true);
    expect(isScriptEntry(NOT_A_SCRIPT)).toBe(false);
    expect(isScriptEntry(["bun"])).toBe(false);
  });
});

/** Walks up from wherever the runner was started until `turbo.json` appears. */
function repositoryRoot(): string {
  let dir = process.cwd();

  while (!existsSync(join(dir, "turbo.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("No turbo.json above " + process.cwd());
    dir = parent;
  }

  return dir;
}

describe("no script can reach a database around the guard", () => {
  const root = repositoryRoot();
  const directories = [
    join(root, "packages/db/src/scripts"),
    join(root, "packages/jobs/scripts"),
  ];

  /**
   * `connectDb` and `createJobDb` call the guard themselves, so a script that
   * uses either is covered by doing nothing. A script that opens its own
   * connection is not, and has to call the guard by hand — this is what makes
   * forgetting a failing test rather than a silent write to the real books.
   */
  const files = directories.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, path: join(dir, name) })),
  );

  test("there are scripts to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { name, path } of files) {
    const source = readFileSync(path, "utf8");
    const opensItsOwn = /new (Client|Pool)\s*\(/.test(source);

    if (!opensItsOwn) continue;

    test(`${name} opens its own connection and calls the guard`, () => {
      // The test-database scripts are the exception the guard does not cover
      // and does not need to: they refuse anything that is not localhost
      // before they connect, which is a stricter rule than this one.
      const testDatabaseOnly = /resolveTestConnection|TEST_DATABASE_URL/.test(
        source,
      );

      expect(
        testDatabaseOnly || source.includes("guardScriptConnection("),
      ).toBe(true);
    });
  }
});
