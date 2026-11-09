import { EMBEDDING, embeddingModel } from "@midday/ai";
import { embed, embedMany } from "ai";

const EMBEDDING_CONFIG = {
  model: embeddingModel(),
  providerOptions: EMBEDDING.providerOptions,
  modelName: EMBEDDING.id,
};

export class Embed {
  public async embedMany(content: string[]): Promise<{
    embeddings: number[][];
    model: string;
  }> {
    const { embeddings } = await embedMany({
      model: EMBEDDING_CONFIG.model,
      values: content,
      providerOptions: EMBEDDING_CONFIG.providerOptions,
    });

    return {
      embeddings,
      model: EMBEDDING_CONFIG.modelName,
    };
  }

  public async embed(content: string): Promise<{
    embedding: number[];
    model: string;
  }> {
    const { embedding } = await embed({
      model: EMBEDDING_CONFIG.model,
      value: content,
      providerOptions: EMBEDDING_CONFIG.providerOptions,
    });

    return {
      embedding,
      model: EMBEDDING_CONFIG.modelName,
    };
  }
}
