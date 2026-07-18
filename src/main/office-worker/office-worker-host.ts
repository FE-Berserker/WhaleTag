/**
 * Parent-side host for the persistent office→PDF python UNO worker
 * (`uno-worker.py`). Drives a long-running `soffice` listener so each
 * conversion no longer pays the 2–5s Windows cold-start of a fresh
 * `soffice --convert-to pdf` process.
 *
 * Shape mirrors `index-worker-host.ts` (lazy memoised spawn, reqId-keyed
 * `pending` map, exit → reject-all + clear + lazy respawn on next request,
 * shutdown kill). The differences, because the child is an EXTERNAL python
 * process (not a Node utilityProcess):
 *   - spawn via `child_process.spawn` (NOT `utilityProcess.fork`); the script
 *     ships via `extraResources`, NOT inside app.asar (`spawn` isn't asar-aware).
 *   - transport is line-delimited JSON over stdin/stdout (NOT postMessage).
 *   - `cwd` is load-bearing on Windows — LO's bundled python can only
 *     `import uno` when cwd is the LO `program/` dir.
 *
 * Availability / fallback: the worker is strictly an optimization. When it
 * can't start (LibreOffice missing, no python-with-uno, listener won't boot,
 * ready timeout, repeated crashes), `markUnavailable()` sets an exponential
 * cooldown and `ensureSpawned()`/`request()` throw `WorkerUnavailableError` —
 * which `convertOfficeToPdfVia` catches and falls back to the legacy
 * `execFile` path. Per-document conversion errors do NOT mark the worker
 * unavailable (only that one request is rejected).
 *
 * See docs/17-office-worker.md.
 */

import path from 'path';
import os from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { rmSync, promises as fsp } from 'fs';
import { terminateSpawnedProcess } from '../ai/utils/windowsCmdShim';
import { resolveOfficeWorkerScriptPath } from './office-worker-script';
import {
  resolveOfficePython,
  resetOfficePythonCache,
} from './office-worker-python';
import { sofficeBinary } from '../thumbnail';

/** Thrown when the worker can't service a request — callers fall back to execFile. */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

// --- protocol types (one JSON object per stdio line) ---

interface ReadyMsg {
  kind: 'ready';
  listenerPid: number;
}
interface FatalMsg {
  kind: 'fatal';
  reason: string;
  message?: string;
}
interface LogMsg {
  kind: 'log';
  level: string;
  message: string;
}
interface OkMsg {
  reqId: string;
  ok: true;
}
interface ErrMsg {
  reqId: string;
  ok: false;
  error: { name: string; message: string; stack?: string };
}
type WorkerMessage = ReadyMsg | FatalMsg | LogMsg | OkMsg | ErrMsg;

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
}

// --- child state ---

let child: ChildProcess | null = null;
let spawnPromise: Promise<void> | null = null;
let spawnResolve: (() => void) | null = null;
let spawnReject: ((e: Error) => void) | null = null;
const pending = new Map<string, Pending>();
let listenerPid: number | null = null;
/** True when WE initiated the child's exit (fatal / kill) — suppresses the
 * unexpected-exit accounting in the exit handler. */
let dying = false;
let profileDir: string | null = null;

let stdoutBuf = '';
let stderrBuf = '';

// --- cooldown FSM ---

let unavailableUntil = 0;
let consecutiveBootFailures = 0;
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60_000;
const MAX_BOOT_FAILURES = 3;
const READY_TIMEOUT_MS = 10_000;
const STDERR_TAG = '[whale-office-worker] ';

/** True when the worker is allowed to be used (outside any cooldown window). */
export function isAvailable(): boolean {
  return Date.now() >= unavailableUntil;
}

function markUnavailable(_reason: string): void {
  consecutiveBootFailures += 1;
  const backoff = Math.min(
    COOLDOWN_MAX_MS,
    COOLDOWN_BASE_MS * 2 ** (consecutiveBootFailures - 1)
  );
  unavailableUntil = Date.now() + backoff;
  // Force a fresh python probe next attempt (the binary may have appeared).
  resetOfficePythonCache();
}

function markAvailable(): void {
  consecutiveBootFailures = 0;
  unavailableUntil = 0;
}

function writeStdin(obj: unknown): void {
  if (!child?.stdin) return;
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function rejectAllPending(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function finishBoot(): void {
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  if (spawnResolve) {
    const r = spawnResolve;
    spawnResolve = null;
    spawnReject = null;
    r();
  }
}

function handleFatal(reason: string, detail?: string): void {
  // Boot-time fatal: cool down, reject any in-flight boot waiters + requests,
  // and gracefully kill the python so its atexit reaps the soffice listener.
  markUnavailable(reason);
  dying = true;
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  const msg = detail
    ? `office worker fatal: ${reason} (${detail})`
    : `office worker fatal: ${reason}`;
  if (spawnReject) {
    const r = spawnReject;
    spawnResolve = null;
    spawnReject = null;
    r(new WorkerUnavailableError(msg));
  }
  rejectAllPending(new WorkerUnavailableError(msg));
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead — exit handler will clean up
    }
  }
}

function handleMessage(msg: WorkerMessage): void {
  if ('kind' in msg) {
    if (msg.kind === 'ready') {
      listenerPid = msg.listenerPid;
      markAvailable();
      finishBoot();
    } else if (msg.kind === 'fatal') {
      handleFatal(msg.reason, msg.message);
    } else if (msg.kind === 'log') {
      process.stderr.write(`${STDERR_TAG}${msg.level}: ${msg.message}\n`);
    }
    return;
  }
  // Per-request response (has reqId). A failure here is a per-DOC error —
  // reject just this request, do NOT mark the worker unavailable.
  if (!('reqId' in msg)) return;
  const p = pending.get(msg.reqId);
  if (!p) return; // late reply after a crash — drop
  pending.delete(msg.reqId);
  if ('error' in msg) {
    // ErrMsg — per-doc conversion failure (do NOT mark unavailable).
    const e = new Error(msg.error.message);
    e.name = msg.error.name;
    if (msg.error.stack) e.stack = msg.error.stack;
    p.reject(e);
  } else {
    p.resolve();
  }
}

let readyTimer: NodeJS.Timeout | null = null;

/**
 * Lazily boot the worker (resolve python, mkdtemp a profile dir, spawn, wait
 * for `ready`). Memoised so concurrent first-callers share one boot.
 *
 * MUST be called OUTSIDE `sofficeSemaphore` — the 2–6s boot would otherwise
 * block every other conversion. The caller then wraps only `request()` in the
 * semaphore. Throws `WorkerUnavailableError` on any boot failure or while in
 * cooldown; the caller falls back to execFile.
 */
export async function ensureSpawned(): Promise<void> {
  if (child && !dying) return;
  if (spawnPromise) return spawnPromise;
  if (!isAvailable()) {
    throw new WorkerUnavailableError('office worker in cooldown');
  }

  spawnPromise = doSpawn();
  try {
    await spawnPromise;
  } catch (e) {
    spawnPromise = null;
    throw e;
  }
  spawnPromise = null;
}

/** How to spawn the worker. Tests override via `__setSpawnSpecResolverForTest`. */
interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Overrides READY_TIMEOUT_MS for the ready handshake (tests). */
  readyTimeoutMs?: number;
}

// Test-only override: when set, bypass real soffice/python discovery and spawn
// exactly this command. Lets office-worker-host.test.ts drive the host with a
// fake worker (a small node script) that speaks the same JSON-line protocol.
// Production leaves this null.
let _spawnSpecResolver: (() => Promise<SpawnSpec>) | null = null;
export function __setSpawnSpecResolverForTest(
  resolver: (() => Promise<SpawnSpec>) | null
): void {
  _spawnSpecResolver = resolver;
}

async function resolveSpawnSpec(): Promise<SpawnSpec> {
  if (_spawnSpecResolver) return _spawnSpecResolver();
  // soffice is required (the worker spawns it as the listener binary). system
  // python+uno without LibreOffice is useless here.
  const soffice = await sofficeBinary(null);
  if (!soffice) {
    markUnavailable('no-soffice');
    throw new WorkerUnavailableError('LibreOffice (soffice) not found');
  }
  const py = await resolveOfficePython(soffice);
  if (!py) {
    markUnavailable('no-python');
    throw new WorkerUnavailableError('no python with pythonuno found');
  }
  profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-lo-profile-'));
  const script = resolveOfficeWorkerScriptPath();
  return {
    command: py.python,
    args: ['-u', script, '--soffice', soffice, '--profile-dir', profileDir],
    cwd: py.cwd,
  };
}

async function doSpawn(): Promise<void> {
  const spec = await resolveSpawnSpec();
  return new Promise<void>((resolve, reject) => {
    spawnResolve = resolve;
    spawnReject = reject;
    dying = false;
    stdoutBuf = '';
    stderrBuf = '';

    const c = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // CRITICAL on Windows: bundled python needs cwd = LO program/ to
      // import uno (pyuno.pyd DLL search path). Harmless elsewhere.
      cwd: spec.cwd,
      windowsHide: true,
    });
    child = c;

    c.stdout?.setEncoding('utf8');
    c.stdout?.on('data', (chunk: string) => {
      if (c !== child) return; // stale child — see exit handler
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleMessage(JSON.parse(trimmed) as WorkerMessage);
        } catch {
          process.stderr.write(`${STDERR_TAG}malformed stdout: ${trimmed}\n`);
        }
      }
    });

    c.stderr?.setEncoding('utf8');
    c.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
      process.stderr.write(STDERR_TAG + chunk);
    });

    c.on('exit', (code, signal) => {
      // Stale child: a prior worker whose exit arrived AFTER `child` was
      // replaced (next doSpawn) or nulled (killOfficeWorker). Its shutdown is
      // already accounted for — handling it here would reject the NEW spawn
      // and null the live child. This is a real race in production too (a
      // crashed worker's late exit must not poison the respawned one), not
      // just a test artifact.
      if (c !== child) return;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (dying) {
        // Expected exit (fatal handler or killOfficeWorker initiated it).
        // State was already cleaned up by the initiator.
        dying = false;
        child = null;
        spawnResolve = null;
        spawnReject = null;
        return;
      }
      // Unexpected exit mid-run — reject everyone, count toward crash limit.
      const err = new WorkerUnavailableError(
        `office worker exited unexpectedly (code=${code} signal=${signal})`
      );
      if (spawnReject) {
        const r = spawnReject;
        spawnResolve = null;
        spawnReject = null;
        r(err);
      }
      rejectAllPending(err);
      child = null;
      consecutiveBootFailures += 1;
      if (consecutiveBootFailures >= MAX_BOOT_FAILURES) {
        markUnavailable('crash');
      }
    });

    c.on('error', (err) => {
      if (c !== child) return; // stale child — see exit handler
      // Spawn-time failure (ENOENT etc.). The 'exit' event usually follows;
      // set dying so the exit handler doesn't double-count.
      dying = true;
      handleFatal('spawn-error', err.message);
    });

    readyTimer = setTimeout(() => {
      handleFatal('ready-timeout');
    }, spec.readyTimeoutMs ?? READY_TIMEOUT_MS);
    readyTimer.unref?.();
  });
}

/**
 * Send one convert request and await the correlated response. The caller MUST
 * have called `ensureSpawned()` first (outside the semaphore) and wraps THIS
 * call in `sofficeSemaphore.run` (the worker's Desktop is single-threaded).
 *
 * Throws `WorkerUnavailableError` if the worker died between ensure and
 * request (caller falls back). Throws a plain `Error` on a per-document
 * conversion failure (caller surfaces it).
 */
export async function request(
  srcPath: string,
  outPdfPath: string
): Promise<void> {
  if (!child || dying) {
    throw new WorkerUnavailableError('office worker not running');
  }
  const reqId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    writeStdin({ reqId, srcPath, outPdfPath });
  });
}

/** Best-effort stderr tail (last ~64KB) for diagnostics. */
export function recentStderr(): string {
  return stderrBuf;
}

// Type-locked wrapper so `terminateSpawnedProcess`'s `SpawnProcess` parameter
// is satisfied without fighting child_process.spawn's overload union.
const spawnIgnoreStdio = (
  command: string,
  args: string[]
): unknown =>
  spawn(command, args, { stdio: 'ignore', windowsHide: true });

/**
 * Best-effort shutdown for app-quit (`before-quit`). Rejects pending, kills
 * the python worker, AND the soffice listener grandchild:
 *   - SIGTERM the python first (its atexit reaps the listener on POSIX).
 *   - tree-kill (Windows `taskkill /t /f`) cascades to the soffice grandchild.
 *   - defensively SIGKILL the reported `listenerPid` (covers POSIX where
 *     python was already dead before atexit ran).
 */
export function killOfficeWorker(): void {
  if (pending.size > 0) {
    const e = new Error('office worker killed at app shutdown');
    rejectAllPending(e);
  }
  dying = true;
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  spawnResolve = null;
  spawnReject = null;
  spawnPromise = null;

  const c = child;
  const lpid = listenerPid;
  const dir = profileDir;
  child = null;
  listenerPid = null;
  profileDir = null;

  if (!c) {
    // A stale listener pid without a python child (python already gone).
    if (lpid != null) {
      try {
        process.kill(lpid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  } else {
    try {
      c.kill('SIGTERM');
    } catch {
      // already dead
    }
    terminateSpawnedProcess(c, 'SIGKILL', spawnIgnoreStdio, {
      // terminateSpawnedProcess only reads killProcessTree (it dispatches
      // taskkill with the pid); command/args satisfy the type but are unused.
      command: '',
      args: [],
      killProcessTree: true,
    });
    if (lpid != null) {
      try {
        process.kill(lpid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  }

  // Best-effort profile-dir cleanup (sync — app is exiting). The listener
  // may still hold files for an instant after the kill; force:true tolerates.
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS tmpdir reaper will get it eventually.
    }
  }
}

/** Test-only: reset ALL module state (kills any live child, clears cooldown
 * counters, stderr buffer, and the spawn-spec resolver). Call between tests. */
export function __resetStateForTest(): void {
  killOfficeWorker();
  unavailableUntil = 0;
  consecutiveBootFailures = 0;
  _spawnSpecResolver = null;
  stdoutBuf = '';
  stderrBuf = '';
}
