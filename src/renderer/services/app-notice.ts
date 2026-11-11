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
 * callable from effects/callbacks without subscribing the whole tree, and a
 * listener added after a notice was emitted simply misses it (transient UI).
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

/** Push a transient notice to the app-level host. */
export function notifyApp(
  message: string,
  severity: AppNoticeSeverity = 'error'
): void {
  if (!message) return;
  const notice: AppNotice = { id: nextId++, message, severity };
  for (const listener of listeners) {
    // A throwing host must not break the caller — most call sites sit inside a
    // `.catch()` on an IPC promise, where a throw would turn a handled failure
    // back into an unhandled rejection.
    try {
      listener(notice);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[app-notice] listener failed', e);
    }
  }
}

/** Subscribe to notices. Returns the unsubscribe function. */
export function subscribeAppNotices(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
