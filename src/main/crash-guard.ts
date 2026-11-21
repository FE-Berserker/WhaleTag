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

import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
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

const DEFAULT_CRASH_LOG_MAX_BYTES = 1024 * 1024;

export interface CrashLogRetentionOptions {
  /** Rotate before this append would make the active log exceed this size. */
  maxBytes?: number;
}

function warnRotationFailure(error: unknown): void {
  console.warn(
    `[crash-guard] Could not rotate crash log; appending to the existing file: ${sanitizeErrorDetail(error)}`
  );
}

function rotateCrashLog(filePath: string, incomingBytes: number, maxBytes: number): void {
  let currentBytes: number;
  try {
    currentBytes = statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    warnRotationFailure(error);
    return;
  }

  if (currentBytes + incomingBytes <= maxBytes) return;

  try {
    const backupPath = `${filePath}.1`;
    // Removing the retired backup first also works on Windows, where renaming
    // over an existing file can fail. If a later step fails, the active log is
    // still intact and the caller continues by appending the new crash entry.
    rmSync(backupPath, { force: true });
    renameSync(filePath, backupPath);
  } catch (error) {
    warnRotationFailure(error);
  }
}

/** Append one complete crash entry, retaining at most one rotated backup. */
export function appendCrashLog(
  filePath: string,
  entry: string,
  options: CrashLogRetentionOptions = {}
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  // Never truncate an individual crash record. An entry larger than the limit
  // is kept intact and becomes the active log until the following append.
  rotateCrashLog(
    filePath,
    Buffer.byteLength(entry, 'utf8'),
    options.maxBytes ?? DEFAULT_CRASH_LOG_MAX_BYTES
  );
  // Append-only open preserves earlier crash evidence. Harden the descriptor
  // BEFORE writing the new stack trace: if chmod fails, no sensitive bytes from
  // this entry may reach an existing, potentially world-readable log. Windows
  // has no useful POSIX mode bits, so retain its normal append path.
  const fd = openSync(filePath, 'a', 0o600);
  try {
    if (process.platform !== 'win32') {
      fchmodSync(fd, 0o600);
    }
    writeFileSync(fd, entry, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
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
export function sanitizeErrorDetail(
  value: unknown,
  maxLength = 4_000,
  homeDirectory = homedir()
): string {
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
  // Crash reports leave the machine when a user files an issue. Replace both
  // native and slash-normalized home prefixes (renderer stacks often use
  // file:///C:/... URLs). Never treat the filesystem root itself as a prefix.
  let redacted = cleaned;
  if (homeDirectory.length > 1) {
    const needles = new Set([
      homeDirectory,
      homeDirectory.replace(/\\/g, '/'),
    ]);
    for (const needle of needles) {
      redacted = redacted.split(needle).join('~');
    }
  }
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}… (truncated)`;
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
  const summary = sanitizeErrorDetail(
    error instanceof Error ? error.message : String(error)
  );

  deps.log('[main] uncaughtException:', error);

  try {
    deps.appendCrashLog(formatCrashEntry('main', sanitizeErrorDetail(detail)));
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
