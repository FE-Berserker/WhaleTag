/**
 * Request/response correlation shared by the host (renderer) and the built-in
 * extensions.
 *
 * `fileEmbed` and `requestFile` started out fire-and-forget: the extension
 * asked for something and trusted the *next* reply to be the answer. A dropped
 * file's thumbnail goes through `loadFolderThumbnail` / `generateThumbnail` /
 * `readFileBase64`, so two drops in quick succession can be answered out of
 * order — the first reply would be placed at the second drop's coordinates
 * (and the second reply fell back to the default spot because the single
 * pending slot had already been consumed).
 *
 * Requests now carry a `requestId` and whoever is waiting keeps a small
 * registry: a reply is accepted only while its id is still pending, and ids
 * expire so a lost reply cannot leak memory or swallow a later one.
 *
 * The registry is deliberately tiny and DOM-free — extensions bundle it
 * through webpack, so it must stay dependency-free.
 */

export interface PendingRequestRegistryOptions {
  /** Drop a request that never got an answer after this many ms. */
  timeoutMs: number;
  /** Called once per request that expired instead of being answered. */
  onTimeout?: (id: string) => void;
  /** Test seam for the timer queue; defaults to `setTimeout`. */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** Test seam; must cancel a handle returned by `schedule`. */
  cancel?: (handle: unknown) => void;
}

export interface PendingRequestRegistry<P> {
  /**
   * Register `payload` under `id`. Returns false when `id` is already pending
   * — a duplicate id cannot be correlated, so the caller should ignore the
   * second request (and warn).
   */
  begin(id: string, payload: P): boolean;
  /**
   * Consume the payload for `id` and stop its expiry timer. Returns
   * `undefined` for unknown or already-expired ids (late reply).
   */
  settle(id: string): P | undefined;
  has(id: string): boolean;
  size(): number;
  /** Drop every pending request without firing `onTimeout`. */
  clear(): void;
}

interface RegistryEntry<P> {
  payload: P;
  handle: unknown;
}

const defaultSchedule = (callback: () => void, ms: number): unknown =>
  setTimeout(callback, ms);

const defaultCancel = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export function createPendingRequestRegistry<P>({
  timeoutMs,
  onTimeout,
  schedule = defaultSchedule,
  cancel = defaultCancel,
}: PendingRequestRegistryOptions): PendingRequestRegistry<P> {
  const entries = new Map<string, RegistryEntry<P>>();

  return {
    begin(id, payload) {
      if (entries.has(id)) return false;
      const entry: RegistryEntry<P> = { payload, handle: null };
      // Insert before arming the timer so a (test) scheduler that fires
      // synchronously still sees the entry and expires it exactly once.
      entries.set(id, entry);
      entry.handle = schedule(() => {
        if (entries.get(id) !== entry) return;
        entries.delete(id);
        onTimeout?.(id);
      }, timeoutMs);
      return true;
    },

    settle(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      entries.delete(id);
      cancel(entry.handle);
      return entry.payload;
    },

    has(id) {
      return entries.has(id);
    },

    size() {
      return entries.size;
    },

    clear() {
      for (const entry of entries.values()) cancel(entry.handle);
      entries.clear();
    },
  };
}
