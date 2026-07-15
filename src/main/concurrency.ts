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

/**
 * Async counting semaphore — bounds how many async operations run concurrently.
 *
 * Prefer `run(fn)`, which acquires a slot, awaits `fn`, and releases the slot
 * in a `finally` (so a throw can't leak a permit). The hand-off in `release`
 * passes the freed slot directly to the next waiter WITHOUT touching `permits`,
 * which avoids the microtask race where a fresh `acquire()` sneaks in between
 * decrement and the waiter resuming.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.permits = Math.max(1, Math.floor(limit));
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    if (this.waiters.length > 0) {
      // Hand the freed slot directly to the next waiter — do NOT increment
      // `permits` (one out, one in keeps the count correct, race-free).
      this.waiters.shift()?.();
    } else {
      this.permits += 1;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Serialize LibreOffice (`soffice`) conversions. `sofficeConvertArgs` does NOT
 * pass `-env:UserInstallation`, so concurrent soffice processes share the
 * default user profile and contend on LibreOffice's profile lock — concurrent
 * runs can fail or corrupt the profile. Covers BOTH soffice spawn sites:
 * office-viewer's `convertOfficeToPdf` (office-convert.ts) AND the office
 * thumbnail path (`encodeOfficeThumb` in thumbnail.ts).
 */
export const sofficeSemaphore = new Semaphore(1);

/**
 * Shared budget for the other heavyweight external-binary conversions: ffmpeg
 * audio transcode, Calibre `ebook-convert`, and `dwg2dxf` / ODA File Converter.
 * Each saturates a core and does real disk IO; without a cap, opening several
 * heavy files at once spawned many child processes and pressured the main
 * process. Capped at 2 (not os.cpus()) because these are user-initiated,
 * one-at-a-time conversions rather than bulk pipelines.
 */
export const mediaConvertSemaphore = new Semaphore(2);

/**
 * Bounds how many thumbnail *encodes* run at once in the main process.
 *
 * Two paths request thumbnails: the renderer's file-thumb IPC queue
 * (`thumb-load-queue.ts`, already capped at `MAX_CONCURRENT=4`) AND the folder-
 * thumbnail path (`generateFolderThumbnail` / `setFolderThumbnail`), which each
 * delegate to `generateThumbnail`. The folder path has NO renderer-side cap, so
 * expanding a wide tree fanned out many concurrent `generateFolderThumbnail`
 * calls — each kicking off a sharp / ffmpeg / pdfjs / soffice encode — with only
 * per-source `inflight` dedup and no global limit (P1-6).
 *
 * Wrapping the encode inside `doGenerateThumbnail` in this semaphore caps the
 * total concurrent CPU/IO work regardless of caller. 4 matches the renderer's
 * proven file-thumb budget; the cheap `stat` / reuse short-circuit in
 * `doGenerateThumbnail` runs OUTSIDE the permit so cache hits never block.
 */
export const thumbnailSemaphore = new Semaphore(4);
