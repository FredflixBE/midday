/**
 * Which AI model each feature uses, named in one place.
 *
 * Features ask for a purpose (`languageModel("document-extraction")`), never
 * for a model id. Two models were retired under this deployment without anyone
 * noticing (`gemini-3-pro-preview`, `claude-3-haiku-20240307`) because their
 * ids were spread over fifteen files; here a retired id is one line to change,
 * and `/health/dependencies` asks Anthropic whether every id below still
 * exists.
 *
 * Switching a feature to another model is a one-line change to `GENERATION`.
 * The model union is closed, so a typo or an id this deployment has not
 * chosen fails the typecheck rather than the first production call.
 *
 * The call sites that still name their own model are listed, with the ticket
 * that moves each, in `call-sites.test.ts`; that list only shrinks.
 *
 * Generation through this module runs on Claude, paid from the Console API
 * credits behind `ANTHROPIC_API_KEY`. Embeddings stay on Gemini (`GOOGLE_GENERATIVE_AI_API_KEY`)
 * because Anthropic has no embeddings API.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { EmbeddingModel, LanguageModel } from "ai";

/** The Claude models this deployment may use. */
export type ClaudeModel =
  | "claude-opus-5-5"
  | "claude-sonnet-5-5"
  | "claude-haiku-5-5";

export interface ModelChoice {
  model: ClaudeModel;
}

/** What every purpose uses unless a measurement shows a cheaper model holds. */
export const DEFAULT_MODEL: ClaudeModel = "claude-opus-5-5";

/**
 * Every purpose a feature can ask a model for.
 *
 * Add a purpose rather than reuse one that merely happens to share a model
 * today: the point is that each can move on its own.
 */
export const GENERATION = {
  /** Reading a receipt or an invoice: the PDF or image in, its fields out. */
  "document-extraction": { model: DEFAULT_MODEL },
  /** Sorting a document once it is read: its kind, title and tags. */
  "document-classification": { model: DEFAULT_MODEL },
  /** Naming a payment's merchant, category and supplier during a bank sync. */
  "transaction-enrichment": { model: DEFAULT_MODEL },
  /** The assistant in the dashboard, and the insights it writes. */
  assistant: { model: DEFAULT_MODEL },
  /** One-shot helpers behind a field or a button: search filters, tax rate, CSV column mapping. */
  helper: { model: DEFAULT_MODEL },
} as const satisfies Record<string, ModelChoice>;

export type GenerationPurpose = keyof typeof GENERATION;

export const GENERATION_PURPOSES = Object.keys(
  GENERATION,
) as GenerationPurpose[];

/** The Claude model a purpose runs on, for logs and stored provenance. */
export function modelIdFor(purpose: GenerationPurpose): ClaudeModel {
  return GENERATION[purpose].model;
}

/** The model to hand the AI SDK for a purpose. */
export function languageModel(purpose: GenerationPurpose): LanguageModel {
  // The provider reads ANTHROPIC_API_KEY when a request is made, not here, so
  // importing this module never needs the key.
  return anthropic(modelIdFor(purpose));
}

/** Every distinct Claude model in use, each once. */
export function claudeModelsInUse(): ClaudeModel[] {
  return [...new Set(GENERATION_PURPOSES.map(modelIdFor))];
}

/**
 * The embedding model: categories, document tags and search.
 *
 * `id` is also what is stored beside every embedding row, so changing it
 * means re-embedding what is already stored — the vectors of two models are
 * not comparable.
 */
export const EMBEDDING = {
  id: "gemini-embedding-001",
  providerOptions: {
    google: {
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    },
  },
} as const;

export function embeddingModel(): EmbeddingModel {
  return google.textEmbedding(EMBEDDING.id);
}
