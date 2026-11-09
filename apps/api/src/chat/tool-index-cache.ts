import { createHash } from "node:crypto";

/**
 * Where the tool index keeps its embeddings between boots.
 *
 * toolpick accepts a cached file whenever it holds as many vectors as there
 * are tools — it never asks which model made them or from what text. A file
 * written by one embedding model would be read back for another's queries,
 * and every tool search would quietly return the wrong tools. So the file is
 * named after the model and the tools: change either and it is a new file.
 */
export function toolIndexCachePath(
  embeddingModelId: string,
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>,
): string {
  const fingerprint = createHash("sha256")
    .update(embeddingModelId)
    .update(
      JSON.stringify(
        tools.map(({ name, description, inputSchema }) => [
          name,
          description ?? "",
          inputSchema ?? null,
        ]),
      ),
    )
    .digest("hex")
    .slice(0, 12);

  return `.toolpick-cache-${fingerprint}.json`;
}
