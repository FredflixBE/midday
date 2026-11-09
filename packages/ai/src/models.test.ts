import { describe, expect, test } from "bun:test";
import {
  claudeModelsInUse,
  DEFAULT_MODEL,
  EMBEDDING,
  embeddingModel,
  GENERATION_PURPOSES,
  languageModel,
  modelIdFor,
} from "./models.js";

describe("languageModel", () => {
  test("every purpose resolves to a Claude model through the Anthropic provider", () => {
    for (const purpose of GENERATION_PURPOSES) {
      const model = languageModel(purpose);

      expect(typeof model).toBe("object");
      if (typeof model === "string") throw new Error("unreachable");

      expect(model.provider).toBe("anthropic.messages");
      expect(model.modelId).toBe(modelIdFor(purpose));
    }
  });

  test("the default is Claude Opus 5.5", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
  });
});

describe("claudeModelsInUse", () => {
  test("names each model once, whichever purposes share it", () => {
    const models = claudeModelsInUse();

    expect(new Set(models).size).toBe(models.length);
    expect(models).toEqual(
      expect.arrayContaining(GENERATION_PURPOSES.map(modelIdFor)),
    );
  });
});

describe("embeddingModel", () => {
  test("stays on Gemini, because Anthropic has no embeddings API", () => {
    const model = embeddingModel();

    expect(typeof model).toBe("object");
    if (typeof model === "string") throw new Error("unreachable");

    expect(model.modelId).toBe(EMBEDDING.id);
    expect(model.provider).toStartWith("google");
  });
});
