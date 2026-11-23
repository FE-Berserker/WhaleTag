/**
 * Translate redux-persist storage failures into user-visible behaviour.
 *
 * The storage adapter (./storage) cannot call `pause()`/`notifyApp` directly:
 * it is constructed before the store and the persistor exist. configureStore
 * wires this reporter in once both are available.
 *
 * Read failures are the dangerous case. redux-persist treats a rejected read
 * as "nothing to rehydrate" and immediately writes the reducer defaults over
 * the existing file. Pausing the persistor before that write is what protects
 * the user's settings/tag library; a retry is intentionally left to the next
 * launch so the two sources (memory defaults vs disk) never race.
 */

import type { PersistFailureKind } from './storage';

export interface PersistFailureReporterDeps {
  /** Pause redux-persist; no further writes touch the disk this session. */
  pause: () => void;
  /** App-level transient notice (see services/app-notice). */
  notify: (message: string, severity?: 'error' | 'warning' | 'info') => void;
  /** Translate the stable persistence-failure keys. */
  translate: (key: 'persistReadFailed' | 'persistWriteFailed') => string;
  /** Diagnostic log; never throws. */
  log: (message: string, error: unknown) => void;
  /** Injectable clock so the write-notice throttle is testable. */
  now?: () => number;
}

const WRITE_NOTICE_INTERVAL_MS = 30_000;

export function createPersistFailureReporter(
  deps: PersistFailureReporterDeps
): (kind: PersistFailureKind, error: unknown) => void {
  let paused = false;
  let lastWriteNoticeAt = Number.NEGATIVE_INFINITY;

  return (kind: PersistFailureKind, error: unknown): void => {
    deps.log(`[persist] ${kind} failure`, error);

    if (kind === 'read') {
      if (paused) return;
      paused = true;
      deps.pause();
      deps.notify(deps.translate('persistReadFailed'), 'error');
      return;
    }

    // Write/delete failures can be transient (disk full, file lock). Keep
    // retrying, but do not spam a notice on every keystroke flush.
    const now = deps.now ? deps.now() : Date.now();
    if (now - lastWriteNoticeAt < WRITE_NOTICE_INTERVAL_MS) return;
    lastWriteNoticeAt = now;
    deps.notify(deps.translate('persistWriteFailed'), 'error');
  };
}
