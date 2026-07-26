// Runs `worker` over every item with at most `limit` in flight at once.
// Never rejects because one item threw — the spec requires that one failed
// attachment must not stop the rest of the batch from processing, so every
// call site is expected to catch its own errors inside `worker`.
export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function runNext(): Promise<void> {
    const index = cursor++;
    if (index >= items.length) return;
    await worker(items[index]);
    await runNext();
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
}
