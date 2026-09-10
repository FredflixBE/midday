/**
 * Map over items with at most `limit` calls in flight at once.
 *
 * `Promise.all` over a mapped array starts everything at once, which is fine
 * for cheap work and not fine when each item is a model call holding a whole
 * document. Results come back in input order regardless of completion order,
 * and a rejection propagates — callers that must not fail should catch inside
 * their own callback.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };

  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers: Promise<void>[] = [];

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}
