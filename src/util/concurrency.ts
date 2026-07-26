// Concurrency-limited parallel mapper for backend use. Mirrors the pattern in
// static/panel/src/utils/concurrency.ts but lives in the backend bundle so
// it can be imported by S3StorageProvider and other server-side code.

/**
 * Apply an async function to each item with bounded concurrency.
 * Returns results in the same order as the input array.
 * Unlike Promise.all, individual rejections do NOT collapse the batch —
 * they are captured as the result for that index.
 */
export async function mapSettledWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        const value = await fn(items[index]);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
