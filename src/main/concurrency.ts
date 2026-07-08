/**
 * Runs an async mapper over `items` with at most `limit` operations in flight
 * at once. Results come back in input order.
 *
 * Use this instead of `Promise.all(items.map(...))` when `items` is large —
 * e.g. stat-ing every entry in a 10k-file directory, or reading thousands of
 * sidecars — so we don't fan out thousands of concurrent file operations and
 * exhaust the file-descriptor pool / stall the event loop.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array<R>(n);
  const width = Math.max(1, Math.min(limit, n));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < n) {
      const i = cursor++;
      results[i] = await mapper(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
