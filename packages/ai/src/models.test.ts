import { describe, expect, test } from "bun:test";
import { embedMany, generateText } from "ai";
import {
  claudeModelsInUse,
  DEFAULT_MODEL,
  EMBEDDING,
  embeddingModel,
  GENERATION_PURPOSES,
  languageModel,
  languageModelFor,
  type ModelChoice,
  modelIdFor,
} from "./models";

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

describe("effort", () => {
  /** The body of the one request a call made, read off a stubbed fetch. */
  async function requestBodyFor(choice: ModelChoice) {
    const realFetch = globalThis.fetch;
    const realKey = process.env.ANTHROPIC_API_KEY;
    let body: Record<string, any> = {};

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: choice.model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;

    try {
      await generateText({ model: languageModelFor(choice), prompt: "hi" });
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    }

    return body;
  }

  test("a choice with an effort sends it to Claude", async () => {
    const body = await requestBodyFor({
      model: "claude-opus-5-5",
      effort: "low",
    });

    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config?.effort).toBe("low");
  });

  test("a choice without one leaves the model's default", async () => {
    const body = await requestBodyFor({ model: "claude-opus-5-5" });

    expect(body.output_config?.effort).toBeUndefined();
  });
});

describe("embedding batches", () => {
  test("never send Gemini more than 100 texts in one request", async () => {
    // The provider says 2048; the API refuses more than 100 ("at most 100
    // requests can be in one batch"). The assistant's tool index embeds 108.
    const realFetch = globalThis.fetch;
    const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const batchSizes: number[] = [];

    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { requests } = JSON.parse(String(init?.body)) as {
        requests: unknown[];
      };
      batchSizes.push(requests.length);
      return Response.json({
        embeddings: requests.map(() => ({ values: [0.1, 0.2] })),
      });
    }) as typeof fetch;

    try {
      const { embeddings } = await embedMany({
        model: embeddingModel(),
        values: Array.from({ length: 150 }, (_, i) => `tool ${i}`),
      });

      expect(embeddings).toHaveLength(150);
      expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100);
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined)
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
    }
  });
});
