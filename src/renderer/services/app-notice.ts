/**
 * App-wide transient-notice bus.
 *
 * Most views already own a local MUI `Snackbar` (FileList, MapiqueView,
 * DirectoryTree, …) and keep using it. This bus exists for surfaces that have
 * no snackbar of their own — the sidebar action row, the extension-host reload
 * path, boot-time maintenance — so their failures cannot disappear silently.
 * `AppNoticeHost` (mounted once in `Root.tsx`) renders the message.
 *
 * Deliberately a plain module bus instead of a React context: it must be
 * callable from effects/callbacks without subscribing the whole tree. The
 * tradeoff is timing: a notice emitted during store bootstrap (before the host
 * mounts) would be lost, so errors emitted before the *first* subscriber are
 * queued and flushed to that subscriber. Once a host has existed,
 * notifications after it unsubscribes are dropped as before (transient UI).
 */
export type AppNoticeSeverity = 'error' | 'warning' | 'info';

export interface AppNotice {
  id: number;
  message: string;
  severity: AppNoticeSeverity;
}

type Listener = (notice: AppNotice) => void;

let nextId = 1;
const listeners = new Set<Listener>();

// Boot-time errors only (a lost warning is acceptable); bounded so a broken
// startup loop cannot grow this without limit.
const MAX_PENDING = 4;
const pendingBeforeFirstSubscriber: AppNotice[] = [];
let everSubscribed = false;

function deliver(listener: Listener, notice: AppNotice): void {
  // A throwing host must not break the caller — most call sites sit inside a
  // `.catch()` on an IPC promise, where a throw would turn a handled failure
  // back into an unhandled rejection.
  try {
    listener(notice);
  } catch (e) {
    console.error('[app-notice] listener failed', e);
  }
}

/** Push a transient notice to the app-level host. */
export function notifyApp(
  message: string,
  severity: AppNoticeSeverity = 'error'
): void {
  if (!message) return;
  const notice: AppNotice = { id: nextId++, message, severity };
  if (listeners.size === 0) {
    if (
      !everSubscribed &&
      severity === 'error' &&
      pendingBeforeFirstSubscriber.length < MAX_PENDING
    ) {
      pendingBeforeFirstSubscriber.push(notice);
    }
    return;
  }
  for (const listener of listeners) deliver(listener, notice);
}

/** Subscribe to notices. Returns the unsubscribe function. */
export function subscribeAppNotices(listener: Listener): () => void {
  listeners.add(listener);
  if (!everSubscribed) {
    everSubscribed = true;
    // At most one listener can be the "first" one; splice before delivering so
    // a listener that subscribes reentrantly cannot receive the queue twice.
    const queued = pendingBeforeFirstSubscriber.splice(0);
    for (const notice of queued) deliver(listener, notice);
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * How many notices may wait *behind* the one currently on screen.
 *
 * A burst of failures (three sidebar actions in the same tick, a broken boot
 * path) must not queue minutes of toasts: the user would read stale errors
 * long after the action. Older pending notices are dropped first — the newest
 * ones describe the state the user just tried to reach.
 */
export const MAX_NOTICE_QUEUE = 3;

/**
 * Appends `notice` to the visible queue, keeping at most
 * {@link MAX_NOTICE_QUEUE} entries behind the head.
 *
 * The head is never dropped: it is already rendered by the host and owns the
 * running auto-hide timer, so evicting it would make the toast vanish mid-read.
 * Pure so the ordering/eviction contract is unit-testable without a DOM.
 */
export function enqueueNotice(
  queue: readonly AppNotice[],
  notice: AppNotice
): AppNotice[] {
  if (queue.length === 0) return [notice];
  const pending = [...queue.slice(1), notice];
  const kept =
    pending.length > MAX_NOTICE_QUEUE
      ? pending.slice(pending.length - MAX_NOTICE_QUEUE)
      : pending;
  return [queue[0], ...kept];
}
