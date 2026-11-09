/**
 * One real call to every model in use, to prove the keys and the ids work
 * from wherever this runs.
 *
 * The `/health/dependencies` probe only asks Anthropic whether each model
 * exists, which costs nothing. This spends a few tokens per model on an actual
 * answer, so it is run by hand: from Settings → Admin, which starts the
 * `check-ai-models` job.
 */

import { embed, generateText } from "ai";
import {
  type ClaudeModel,
  claudeModelsInUse,
  EMBEDDING,
  embeddingModel,
  GENERATION_PURPOSES,
  type GenerationPurpose,
  languageModel,
  modelIdFor,
} from "./models.js";

export interface ModelCheck {
  model: ClaudeModel | typeof EMBEDDING.id;
  /** The purposes that run on this model. Empty for the embedding model. */
  purposes: GenerationPurpose[];
  ok: boolean;
  ms: number;
  /** Why the call failed, when it did. */
  error?: string;
}

async function timed(
  call: () => Promise<unknown>,
): Promise<Pick<ModelCheck, "ok" | "ms" | "error">> {
  const start = performance.now();
  try {
    await call();
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Calls each model once, one after another, and reports every result. */
export async function checkModels(): Promise<ModelCheck[]> {
  const results: ModelCheck[] = [];

  for (const model of claudeModelsInUse()) {
    const purposes = GENERATION_PURPOSES.filter(
      (purpose) => modelIdFor(purpose) === model,
    );

    // Through the purpose rather than the bare id, so the check exercises
    // exactly what a feature gets.
    const outcome = await timed(() =>
      generateText({
        model: languageModel(purposes[0]!),
        prompt: "Reply with the single word: ok",
        maxOutputTokens: 16,
      }),
    );

    results.push({ model, purposes, ...outcome });
  }

  const outcome = await timed(() =>
    embed({
      model: embeddingModel(),
      value: "ok",
      providerOptions: EMBEDDING.providerOptions,
    }),
  );

  results.push({ model: EMBEDDING.id, purposes: [], ...outcome });

  return results;
}
