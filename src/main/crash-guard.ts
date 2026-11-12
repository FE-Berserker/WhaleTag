/**
 * Crash resilience helpers (docs/01 §14).
 *
 * Two failure modes used to be invisible to the user:
 *  - the renderer process dying (GPU crash / renderer OOM) left a blank window
 *    with no explanation and no way back except killing the whole app;
 *  - an uncaught exception in the main process terminated the app with only a
 *    stderr line that nobody running a packaged build ever sees.
 *
 * The policy lives here as pure functions (testable without an Electron
 * runtime); `main.ts` only wires the Electron APIs around them. Keeping the
 * arithmetic here is deliberate: a crash handler with an off-by-one reload
 * budget turns one crash into a reload loop, which is worse than the blank
 * window it replaces.
 */

import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

export interface RendererGoneDetails {
  reason: string;
  exitCode: number;
}

/** Auto-reloads allowed before we ask the user instead of retrying forever. */
export const MAX_AUTO_RELOADS = 2;

/** The reload budget refills after this long without a crash. */
export const RELOAD_WINDOW_MS = 60_000;

export interface ReloadState {
  /** Reloads already used inside the current window. */
  attempts: number;
  /** Timestamp of the last reload (0 = never). */
  lastReloadAt: number;
}

export interface ReloadPlan {
  reload: boolean;
  next: ReloadState;
}

/**
 * Decide whether a dead renderer should be reloaded automatically.
 *
 * `clean-exit` is what a normal window close looks like — reloading there
 * would resurrect a window the user just closed. Any other reason is a crash.
 * When the previous reload is older than {@link RELOAD_WINDOW_MS} the budget
 * starts over, so an app that crashes once a week still recovers on its own.
 */
export function planReload(
  details: Pick<RendererGoneDetails, 'reason'>,
  state: ReloadState,
  now: number
): ReloadPlan {
  if (details.reason === 'clean-exit') {
    return { reload: false, next: state };
  }
  const withinWindow =
    state.lastReloadAt > 0 && now - state.lastReloadAt <= RELOAD_WINDOW_MS;
  const attempts = withinWindow ? state.attempts : 0;
  if (attempts >= MAX_AUTO_RELOADS) {
    return { reload: false, next: { attempts, lastReloadAt: state.lastReloadAt } };
  }
  return { reload: true, next: { attempts: attempts + 1, lastReloadAt: now } };
}

/** One line for `<userData>/crash.log`; ISO timestamps survive log rotation. */
export function formatCrashEntry(
  kind: 'renderer' | 'main',
  detail: string,
  now: Date = new Date()
): string {
  return `[${now.toISOString()}] ${kind} crash: ${detail}\n`;
}

/** Append one crash entry, creating the log's directory on first use. */
export function appendCrashLog(filePath: string, entry: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, entry, 'utf8');
}

/**
 * Normalize a renderer-supplied error detail before it becomes a crash-log
 * entry. The value crosses the IPC boundary, so it can be of any type and any
 * length: coerce it to a string, drop control characters that would corrupt the
 * log, and cap the size so a runaway error object cannot bloat the file.
 *
 * Newlines are kept: stack traces are the most useful part of the entry and
 * main-process entries already span multiple lines.
 */
export function sanitizeErrorDetail(value: unknown, maxLength = 4_000): string {
  const raw =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? value.stack ?? `${value.name}: ${value.message}`
        : String(value);
  const cleaned = raw
    .replace(/\r/g, '')
    // NUL / control characters (keep \n and \t so stacks stay readable). The
    // control-character class is the point of this line, hence the disable.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}… (truncated)`;
}

export interface FatalErrorDeps {
  log: (message: string, error?: unknown) => void;
  appendCrashLog: (entry: string) => void;
  showErrorBox: (title: string, content: string) => void;
  exit: (code: number) => void;
}

/**
 * Last-resort handler for an uncaught main-process exception.
 *
 * Order matters: log first (stderr may still be attached), then persist the
 * crash entry (the dialog is what the user sees, the file is what the next
 * report can quote), then tell the user, then exit. Every step is isolated —
 * a failing logger, a full disk or a closed dialog must not stop the exit,
 * which would leave a half-dead process holding the single-instance lock.
 */
export function handleFatalError(error: unknown, deps: FatalErrorDeps): void {
  const detail =
    error instanceof Error
      ? error.stack ?? `${error.name}: ${error.message}`
      : String(error);
  const summary = error instanceof Error ? error.message : String(error);

  deps.log('[main] uncaughtException:', error);

  try {
    deps.appendCrashLog(formatCrashEntry('main', detail));
  } catch {
    // Best-effort: an unwritable log must not block the exit below.
  }

  try {
    deps.showErrorBox(
      'WhaleTag hit an unexpected error',
      `${summary}\n\nThe app will close. If this keeps happening, the crash log in the app data folder has the details.`
    );
  } catch {
    // The window server may already be gone (e.g. a crash during shutdown).
  }

  deps.exit(1);
}
