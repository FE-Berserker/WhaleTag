import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MAX_AUTO_RELOADS,
  RELOAD_WINDOW_MS,
  appendCrashLog,
  formatCrashEntry,
  handleFatalError,
  planReload,
  sanitizeErrorDetail,
  type ReloadState,
} from './crash-guard';

const NEVER: ReloadState = { attempts: 0, lastReloadAt: 0 };
const T0 = 1_700_000_000_000;

describe('planReload', () => {
  it('never reloads a clean-exit renderer', () => {
    const plan = planReload({ reason: 'clean-exit' }, NEVER, T0);
    assert.equal(plan.reload, false);
    assert.deepEqual(plan.next, NEVER);
  });

  it('reloads the first crash and records the attempt', () => {
    const plan = planReload({ reason: 'crashed' }, NEVER, T0);
    assert.equal(plan.reload, true);
    assert.deepEqual(plan.next, { attempts: 1, lastReloadAt: T0 });
  });

  it('reloads a second crash inside the window', () => {
    const plan = planReload(
      { reason: 'oom' },
      { attempts: 1, lastReloadAt: T0 },
      T0 + 1_000
    );
    assert.equal(plan.reload, true);
    assert.deepEqual(plan.next, { attempts: 2, lastReloadAt: T0 + 1_000 });
  });

  it('stops reloading at the budget and keeps the state', () => {
    const state: ReloadState = { attempts: MAX_AUTO_RELOADS, lastReloadAt: T0 };
    const plan = planReload({ reason: 'crashed' }, state, T0 + 5_000);
    assert.equal(plan.reload, false);
    assert.deepEqual(plan.next, state);
  });

  it('refills the budget after a quiet window', () => {
    const plan = planReload(
      { reason: 'crashed' },
      { attempts: MAX_AUTO_RELOADS, lastReloadAt: T0 },
      T0 + RELOAD_WINDOW_MS + 1
    );
    assert.equal(plan.reload, true);
    assert.deepEqual(plan.next, {
      attempts: 1,
      lastReloadAt: T0 + RELOAD_WINDOW_MS + 1,
    });
  });

  it('treats exactly one window as still inside the budget', () => {
    const plan = planReload(
      { reason: 'crashed' },
      { attempts: MAX_AUTO_RELOADS, lastReloadAt: T0 },
      T0 + RELOAD_WINDOW_MS
    );
    assert.equal(plan.reload, false);

    const next = planReload(
      { reason: 'crashed' },
      { attempts: MAX_AUTO_RELOADS, lastReloadAt: T0 },
      T0 + RELOAD_WINDOW_MS + 1
    );
    assert.equal(next.reload, true);
  });
});

describe('crash log', () => {
  it('formats a single ISO-timestamped line', () => {
    const entry = formatCrashEntry(
      'renderer',
      'crashed (exitCode=1)',
      new Date('2026-11-12T07:00:00.000Z')
    );
    assert.equal(
      entry,
      '[2026-11-12T07:00:00.000Z] renderer crash: crashed (exitCode=1)\n'
    );
  });

  it('creates the log directory and appends instead of truncating', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-crash-'));
    const file = path.join(dir, 'nested', 'crash.log');
    try {
      appendCrashLog(file, 'first\n');
      appendCrashLog(file, 'second\n');
      assert.equal(await fsp.readFile(file, 'utf8'), 'first\nsecond\n');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rotates at a small byte threshold and retains only one backup', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-crash-'));
    const file = path.join(dir, 'crash.log');
    const backup = `${file}.1`;
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(file, 'first\n', 'utf8');

    appendCrashLog(file, 'second\n', { maxBytes: 12 });
    assert.equal(await fsp.readFile(file, 'utf8'), 'second\n');
    assert.equal(await fsp.readFile(backup, 'utf8'), 'first\n');

    // This second rotation must replace the existing backup on Windows too.
    appendCrashLog(file, 'third\n', { maxBytes: 12 });
    assert.equal(await fsp.readFile(file, 'utf8'), 'third\n');
    assert.equal(await fsp.readFile(backup, 'utf8'), 'second\n');

    appendCrashLog(file, 'fourth\n', { maxBytes: 12 });
    assert.equal(await fsp.readFile(file, 'utf8'), 'fourth\n');
    assert.equal(await fsp.readFile(backup, 'utf8'), 'third\n');
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['crash.log', 'crash.log.1']);
  });

  it('does not rotate when the new entry reaches the limit exactly', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-crash-'));
    const file = path.join(dir, 'crash.log');
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(file, '123456', 'utf8');

    appendCrashLog(file, 'abc', { maxBytes: 9 });

    assert.equal(await fsp.readFile(file, 'utf8'), '123456abc');
    assert.equal(fs.existsSync(`${file}.1`), false);
  });

  it('warns and still appends the current crash when rotation fails', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-crash-'));
    const file = path.join(dir, 'crash.log');
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(file, 'old\n', 'utf8');
    await fsp.writeFile(`${file}.1`, 'retired\n', 'utf8');
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('rotation denied');
    });
    const warn = t.mock.method(console, 'warn', () => {});

    appendCrashLog(file, 'current crash\n', { maxBytes: 4 });

    assert.equal(
      await fsp.readFile(file, 'utf8'),
      'old\ncurrent crash\n',
      'rotation failure must not discard the new crash record'
    );
    assert.equal(warn.mock.callCount(), 1);
    const warning = String(warn.mock.calls[0].arguments[0]);
    assert.match(warning, /Could not rotate crash log/);
    assert.match(warning, /rotation denied/);
  });

  it('does not append sensitive detail when descriptor chmod fails', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-crash-'));
    const file = path.join(dir, 'crash.log');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    t.after(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(file, 'existing\n', { encoding: 'utf8', mode: 0o666 });

    const sensitive = '/home/alice/private/secret.txt\n';
    t.mock.method(fs, 'fchmodSync', (fd: number, mode: number) => {
      assert.equal(typeof fd, 'number');
      assert.equal(mode, 0o600);
      throw new Error('EPERM: chmod failed');
    });

    assert.throws(
      () => appendCrashLog(file, sensitive),
      /EPERM: chmod failed/
    );
    assert.equal(
      await fsp.readFile(file, 'utf8'),
      'existing\n',
      'the failed permission hardening must happen before any new bytes'
    );
  });

  it('applies owner-only mode before writing on POSIX', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not available on Windows');
      return;
    }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-crash-'));
    const file = path.join(dir, 'crash.log');
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(file, 'existing\n', { mode: 0o666 });
    await fsp.chmod(file, 0o666);

    appendCrashLog(file, 'next\n');

    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    assert.equal(await fsp.readFile(file, 'utf8'), 'existing\nnext\n');
  });
});

describe('handleFatalError', () => {
  function recorder() {
    const calls: string[] = [];
    const entries: string[] = [];
    const boxes: { title: string; content: string }[] = [];
    const exits: number[] = [];
    return {
      calls,
      entries,
      boxes,
      exits,
      deps: {
        log: (message: string, error?: unknown) => {
          calls.push(`log:${message}:${String(error)}`);
        },
        appendCrashLog: (entry: string) => {
          calls.push('append');
          entries.push(entry);
        },
        showErrorBox: (title: string, content: string) => {
          calls.push('box');
          boxes.push({ title, content });
        },
        exit: (code: number) => {
          calls.push('exit');
          exits.push(code);
        },
      },
    };
  }

  it('logs, persists, tells the user, then exits with code 1', () => {
    const rec = recorder();
    const error = new Error('boom');
    handleFatalError(error, rec.deps);

    assert.deepEqual(rec.calls, ['log:[main] uncaughtException::Error: boom', 'append', 'box', 'exit']);
    assert.equal(rec.entries.length, 1);
    assert.match(rec.entries[0], /main crash: Error: boom/);
    assert.equal(rec.boxes[0].title, 'WhaleTag hit an unexpected error');
    assert.match(rec.boxes[0].content, /boom/);
    assert.deepEqual(rec.exits, [1]);
  });

  it('stringifies a non-Error throw', () => {
    const rec = recorder();
    handleFatalError('plain failure', rec.deps);
    assert.match(rec.entries[0], /main crash: plain failure/);
    assert.match(rec.boxes[0].content, /plain failure/);
    assert.deepEqual(rec.exits, [1]);
  });

  it('sanitizes both the persisted detail and the user-facing summary', () => {
    const rec = recorder();
    const home = os.homedir();
    const privatePath = path.join(home, 'Documents', 'secret.txt');
    handleFatalError(new Error(`cannot open ${privatePath}`), rec.deps);

    assert.equal(rec.entries[0].includes(home), false, 'crash log home removed');
    assert.equal(rec.boxes[0].content.includes(home), false, 'dialog home removed');
    assert.match(rec.entries[0], /~[\\/]Documents[\\/]secret\.txt/);
    assert.match(rec.boxes[0].content, /~[\\/]Documents[\\/]secret\.txt/);
  });

  it('still exits when the log and the dialog both fail', () => {
    const rec = recorder();
    rec.deps.appendCrashLog = () => {
      rec.calls.push('append');
      throw new Error('disk full');
    };
    rec.deps.showErrorBox = () => {
      rec.calls.push('box');
      throw new Error('no window');
    };

    assert.doesNotThrow(() => handleFatalError(new Error('late'), rec.deps));
    assert.deepEqual(rec.calls, ['log:[main] uncaughtException::Error: late', 'append', 'box', 'exit']);
    assert.deepEqual(rec.exits, [1]);
  });
});

describe('sanitizeErrorDetail', () => {
  it('keeps a plain string as-is', () => {
    assert.equal(sanitizeErrorDetail('uncaught TypeError: x'), 'uncaught TypeError: x');
  });

  it('uses the stack of an Error and stringifies other values', () => {
    const stack = sanitizeErrorDetail(new Error('boom'));
    assert.match(stack, /Error: boom/);
    assert.match(stack, /crash-guard\.test\.ts/);
    assert.equal(sanitizeErrorDetail({ code: 'EPERM' }), '[object Object]');
    assert.equal(sanitizeErrorDetail(null), 'null');
  });

  it('drops CR and control characters but keeps newlines and tabs', () => {
    const cleaned = sanitizeErrorDetail('a\r\nb\tc\u0000d\u0007e');
    assert.equal(cleaned, 'a\nb\tcde');
  });

  it('caps the entry and marks the truncation', () => {
    const long = sanitizeErrorDetail('x'.repeat(50), 10);
    assert.equal(long, `${'x'.repeat(10)}… (truncated)`);
    assert.equal(sanitizeErrorDetail('x'.repeat(4_000)).length, 4_000);
  });

  it('replaces the home directory with ~ before the report leaves the machine', () => {
    const home = os.homedir();
    const detail = `ENOENT: open '${path.join(home, 'Documents', 'a.txt')}'`;
    const sanitized = sanitizeErrorDetail(detail);
    assert.equal(sanitized.includes(home), false, 'home prefix removed');
    assert.match(sanitized, /~[\\/]Documents/);
  });

  it('redacts slash-normalized home paths in renderer file URLs', () => {
    const home = os.homedir();
    const urlHome = home.replace(/\\/g, '/');
    const sanitized = sanitizeErrorDetail(
      `Error at file:///${urlHome}/Documents/a.txt`
    );
    assert.equal(sanitized.includes(urlHome), false, 'URL home prefix removed');
    assert.match(sanitized, /~\/Documents\/a\.txt/);
  });

  it('does not treat a root home directory as a replace-all prefix', () => {
    assert.equal(sanitizeErrorDetail('/etc/passwd', 4_000, '/'), '/etc/passwd');
  });
});
