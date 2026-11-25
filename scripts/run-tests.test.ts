import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

/**
 * `npm test` starts here, so the runner itself is pinned: discovery must find
 * every `*.test.ts(x)` without a hand-maintained list, concurrency must honour
 * `WHALE_TEST_CONCURRENCY`, and the watchdog must kill a silent run quickly and
 * cleanly instead of leaving CI waiting.
 */
const {
  DEFAULT_STALL_MS,
  MAX_CONCURRENCY,
  buildArgs,
  discoverTestFiles,
  resolveConcurrency,
  resolveStallMs,
  runSuite,
} = require('./run-tests.cjs') as {
  DEFAULT_STALL_MS: number;
  MAX_CONCURRENCY: number;
  buildArgs: (files: string[], concurrency: number) => string[];
  discoverTestFiles: (options?: { root?: string; searchDirs?: string[] }) => string[];
  resolveConcurrency: (options?: { env?: NodeJS.ProcessEnv; cpuCount?: number }) => number;
  resolveStallMs: (options?: { env?: NodeJS.ProcessEnv }) => number;
  runSuite: (options: {
    command: string;
    args: string[];
    stallMs?: number;
    hardLimitMs?: number;
    watchIntervalMs?: number;
    stdout?: Writable;
    stderr?: Writable;
  }) => Promise<{ status: number | null; stalled: boolean; hardTimedOut: boolean; error?: Error }>;
};

const ROOT = path.resolve(__dirname, '..');

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('run-tests — discovery', () => {
  it('finds every *.test.ts / *.test.tsx below the search dirs, sorted, without node_modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-run-tests-'));
    try {
      const files = [
        'src/z.test.ts',
        'src/deep/a.test.tsx',
        'src/helper.ts',
        'src/node_modules/skip.test.ts',
        'scripts/c.test.ts',
        'scripts/tool.cjs',
        'other/never.test.ts',
      ];
      for (const rel of files) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '');
      }
      assert.deepEqual(discoverTestFiles({ root }), [
        path.join(root, 'scripts', 'c.test.ts'),
        path.join(root, 'src', 'deep', 'a.test.tsx'),
        path.join(root, 'src', 'z.test.ts'),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers the real suite, this file included', () => {
    const files = discoverTestFiles();
    assert.ok(files.length > 200, `only ${files.length} test files discovered`);
    assert.ok(files.includes(path.join(ROOT, 'src', 'main', 'index-db.test.ts')));
    assert.ok(files.includes(path.join(ROOT, 'scripts', 'run-tests.test.ts')));
    assert.ok(files.includes(path.join(ROOT, 'scripts', 'check-native-abi.test.ts')));
    assert.deepEqual(files, [...files].sort(), 'stable order for readable logs');
    for (const file of files) assert.ok(fs.statSync(file).isFile(), file);
  });
});

describe('run-tests — concurrency and watchdog settings', () => {
  it('defaults to half the CPUs, never above the saturation point', () => {
    assert.equal(resolveConcurrency({ env: {}, cpuCount: 1 }), 1);
    assert.equal(resolveConcurrency({ env: {}, cpuCount: 2 }), 1);
    assert.equal(resolveConcurrency({ env: {}, cpuCount: 4 }), 2);
    assert.equal(resolveConcurrency({ env: {}, cpuCount: 8 }), 4);
    assert.equal(resolveConcurrency({ env: {}, cpuCount: 16 }), MAX_CONCURRENCY);
    assert.equal(resolveConcurrency({ env: {}, cpuCount: 32 }), MAX_CONCURRENCY);
  });

  it('lets WHALE_TEST_CONCURRENCY force the strictly serial run', () => {
    assert.equal(resolveConcurrency({ env: { WHALE_TEST_CONCURRENCY: '1' }, cpuCount: 32 }), 1);
    assert.equal(resolveConcurrency({ env: { WHALE_TEST_CONCURRENCY: '3' }, cpuCount: 32 }), 3);
    assert.equal(resolveConcurrency({ env: { WHALE_TEST_CONCURRENCY: ' 2 ' }, cpuCount: 32 }), 2);
    assert.equal(resolveConcurrency({ env: { WHALE_TEST_CONCURRENCY: '' }, cpuCount: 4 }), 2);
  });

  it('refuses a concurrency that is not a usable integer', () => {
    for (const raw of ['0', '-2', '1.5', 'abc', '65']) {
      assert.throws(
        () => resolveConcurrency({ env: { WHALE_TEST_CONCURRENCY: raw }, cpuCount: 4 }),
        /WHALE_TEST_CONCURRENCY/,
        raw
      );
    }
  });

  it('keeps the watchdog at four minutes unless WHALE_TEST_STALL_MS lengthens it', () => {
    assert.equal(resolveStallMs({ env: {} }), DEFAULT_STALL_MS);
    assert.equal(resolveStallMs({ env: { WHALE_TEST_STALL_MS: '5000' } }), 5000);
    assert.equal(resolveStallMs({ env: { WHALE_TEST_STALL_MS: '500' } }), 1000);
    assert.throws(() => resolveStallMs({ env: { WHALE_TEST_STALL_MS: 'soon' } }), /WHALE_TEST_STALL_MS/);
  });

  it('passes concurrency, the spec reporter and the ts-node preload hooks to Electron', () => {
    const args = buildArgs(['a.test.ts', 'b.test.tsx'], 4);
    assert.equal(args[0], '--test');
    assert.ok(args.includes('--test-concurrency=4'));
    assert.ok(args.includes('--test-reporter=spec'));
    const requireIdx = args.indexOf('--require');
    assert.deepEqual(args.slice(requireIdx, requireIdx + 6), [
      '--require',
      'ts-node/register',
      '--require',
      'tsconfig-paths/register',
      '--require',
      path.join(ROOT, 'scripts', 'test-asset-stub.cjs'),
    ]);
    assert.deepEqual(args.slice(-2), ['a.test.ts', 'b.test.tsx']);
  });
});

describe('run-tests — suite process control', () => {
  it('forwards stdout and stderr and reports the exit status', async () => {
    const out = sink();
    const err = sink();
    const result = await runSuite({
      command: process.execPath,
      args: ['-e', "console.log('to out'); console.error('to err'); process.exit(3)"],
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.deepEqual(result, { status: 3, stalled: false, hardTimedOut: false, error: undefined });
    assert.equal(out.text(), 'to out\n');
    assert.equal(err.text(), 'to err\n');
  });

  it('kills a silent run once the stall limit passes', async () => {
    const out = sink();
    const startedAt = Date.now();
    const result = await runSuite({
      command: process.execPath,
      // Talks once, then falls silent for good.
      args: ['-e', "console.log('started'); setInterval(() => {}, 1000)"],
      stallMs: 200,
      watchIntervalMs: 20,
      stdout: out.stream,
      stderr: out.stream,
    });
    assert.equal(result.stalled, true, 'the watchdog must report the kill');
    assert.equal(result.status, null, 'a killed run has no exit status to trust');
    // No assertion on the child's single line: on a loaded machine the binary
    // may still be starting when the short limit passes — that is the kill
    // path working, not a forwarding problem (covered above).
    assert.ok(Date.now() - startedAt < 8000, 'the silent process is killed, not waited out');
  });

  it('resets the stall clock on every output line', async () => {
    const out = sink();
    // The watchdog starts at spawn, so the margin must also cover a slow start
    // of the Electron binary on a loaded machine (observed: > 1 s at
    // concurrency 6). Six lines 450 ms apart — the first one at once — keep
    // every gap under the limit while the whole run outlasts it: the last
    // line lands 2.25 s after the process started, past the 2 s limit.
    const result = await runSuite({
      command: process.execPath,
      args: [
        '-e',
        "let n = 0; const tick = () => { console.log('tick ' + n++); if (n === 6) clearInterval(t); }; tick(); const t = setInterval(tick, 450)",
      ],
      stallMs: 2000,
      watchIntervalMs: 50,
      stdout: out.stream,
      stderr: out.stream,
    });
    assert.equal(result.stalled, false);
    assert.equal(result.status, 0);
    assert.equal((out.text().match(/tick/g) ?? []).length, 6);
  });

  it('reports a command that cannot be spawned', async () => {
    const missing = path.join(os.tmpdir(), 'whale-no-such-electron', 'electron.exe');
    const result = await runSuite({
      command: missing,
      args: ['--test'],
      stallMs: 1000,
      stdout: sink().stream,
      stderr: sink().stream,
    });
    assert.equal(result.status, null);
    assert.ok(result.error, 'the spawn error is handed back to the caller');
  });
});
