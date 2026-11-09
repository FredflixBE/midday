/**
 * Every AI call site gets its model from `@midday/ai`, never by naming one.
 *
 * A model can only be named where its provider package is imported, or as a
 * literal model id, so the check is two rules over every source file in
 * `apps/` and `packages/`:
 *
 * 1. Only this package imports an AI SDK model provider.
 * 2. Only this package spells a model id.
 *
 * `PENDING` is the call sites the epic (FF-2269) has not moved yet, each with
 * the ticket that moves it. The list may only shrink: an entry that no longer
 * breaks a rule fails the test, so it is removed in the change that moves it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

/**
 * Packages that construct a model: the AI SDK's providers and the vendors' own
 * SDKs. The AI SDK's UI hooks, MCP client and shared types construct none.
 */
const PROVIDER_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](@ai-sdk\/(?:anthropic|google|google-vertex|openai|openai-compatible|mistral|gateway|groq|xai|deepseek|cohere|amazon-bedrock|azure|perplexity|togetherai|fireworks)|openai|@anthropic-ai\/sdk|@google\/genai|@google\/generative-ai|@mistralai\/mistralai)["']/;

/** A model id as a string literal, or a gateway id such as "openai/gpt-4o". */
const MODEL_ID =
  /["'`]((?:[a-z-]+\/)?(?:claude|gemini|gpt|mistral|pixtral|magistral|text-embedding)-[\w.-]*)["'`]/g;

/** App-store ids such as "claude-mcp" share the prefix and name no model. */
const NOT_A_MODEL = /-mcp$/;

const PENDING: Record<string, string> = {
  "apps/api/evals/tool-selection.eval.ts": "FF-2274",
  "apps/api/src/chat/assistant-runtime.ts": "FF-2274",
  "apps/api/src/chat/tools.ts": "FF-2274",
  "apps/api/src/chat/utils.ts": "FF-2274",
  "apps/api/src/trpc/routers/transactions.ts": "FF-2275",
  "apps/api/src/utils/search-filters.ts": "FF-2274",
  "apps/dashboard/src/actions/ai/get-tax-rate.ts": "FF-2274",
  "packages/documents/src/classifier/classifier.ts": "FF-2272",
  "packages/documents/src/config/extraction-config.ts": "FF-2272",
  "packages/documents/src/loaders/loader.ts": "FF-2272",
  "packages/documents/src/processors/base-extraction-engine.ts": "FF-2272",
  "packages/documents/src/utils/domain-lookup.ts": "FF-2272",
  "packages/insights/evals/insight.eval.ts": "FF-2274",
  "packages/insights/evals/scorers.ts": "FF-2274",
  "packages/insights/src/content/generator.ts": "FF-2274",
  "packages/jobs/scripts/link-suppliers.ts": "FF-2273",
  "packages/jobs/src/tasks/inbox/slack-upload.ts": "FF-2274",
  "packages/jobs/src/tasks/transactions/enrich-transaction.ts": "FF-2273",
};

/**
 * Files that spell a model id without calling a model. The database stores
 * which embedding model made each vector, so its schema and queries name it as
 * a label.
 */
const LABELS_ONLY = [
  "packages/db/src/schema.ts",
  "packages/db/src/queries/transaction-category-embeddings.ts",
];

function sourceFiles(): string[] {
  // Tracked and untracked-but-not-ignored, so a file nobody has committed yet
  // is checked too, and node_modules and build output never are.
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "packages",
    ],
    { cwd: ROOT },
  );

  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }

  return (
    listed.stdout
      .toString()
      .split("\n")
      .filter((file) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(file))
      .filter((file) => !file.startsWith("packages/ai/"))
      // Tests may name a model to mock or assert one; they call none.
      .filter((file) => !/\.test\.tsx?$|\/__tests__\//.test(file))
  );
}

function breaksARule(file: string): string | null {
  let source: string;
  try {
    source = readFileSync(join(ROOT, file), "utf8");
  } catch {
    // Listed by git but deleted in the working tree.
    return null;
  }

  const provider = source.match(PROVIDER_IMPORT);
  if (provider) return `imports ${provider[1]}`;

  if (LABELS_ONLY.includes(file)) return null;

  for (const [, id] of source.matchAll(MODEL_ID)) {
    if (id && !NOT_A_MODEL.test(id)) return `names the model "${id}"`;
  }

  return null;
}

describe("AI call sites", () => {
  const files = sourceFiles();

  test("finds the source files to check", () => {
    // A broken listing would otherwise pass every rule vacuously.
    expect(files.length).toBeGreaterThan(500);
  });

  test("get their model from @midday/ai, except the ones still to move", () => {
    const offenders = files
      .filter((file) => !(file in PENDING))
      .map((file) => [file, breaksARule(file)] as const)
      .filter(([, reason]) => reason !== null)
      .map(([file, reason]) => `${file} ${reason}`);

    expect(offenders).toEqual([]);
  });

  test("the list still to move only names files that still need it", () => {
    const moved = Object.entries(PENDING)
      .filter(([file]) => breaksARule(file) === null)
      .map(([file, ticket]) => `${file} (${ticket})`);

    expect(moved).toEqual([]);
  });
});
