#!/usr/bin/env node
/**
 * Test runner entry point.
 *
 * Auto-discovers every `*.test.ts` / `*.test.tsx` under `src/` and `scripts/`
 * and runs them through Electron's `--test` (Node's built-in test runner, with
 * ts-node for on-the-fly transpilation).
 *
 * Auto-discovery replaced the hand-maintained explicit file list that used to
 * live inline in the package.json `test` script. That list had drifted: 8 test
 * files were never listed (so they silently never ran) and 1 phantom entry
 * pointed at a non-existent file.
 *
 * Concurrency: files run in up to `WHALE_TEST_CONCURRENCY` processes (default
 * from the CPU count, capped at 6; `1` is the strictly serial run). The suite
 * used to be pinned to `--test-concurrency=1` for a node:test deadlock that
 * did not reproduce in five full parallel runs (2026-11, Electron 42.11 /
 * Node 24.19): serial 252 s, 2 → 134 s, 4 → 75 s, 6 → 60 s, 8 → 64 s, 12 → 72 s.
 *
 * Watchdog instead of a pin: no output for `WHALE_TEST_STALL_MS` (default
 * 4 min; the slowest single file takes about 1 min) kills the whole process
 * tree and the suite is re-run serially with a notice, so a rare scheduler
 * hang can neither turn a run red nor hang CI.
 *
 * Deliberately dependency-free. Discovery used to `require('glob')`, which was
 * never declared in package.json — it only worked because a transitive dev
 * dependency happened to be hoisted. Every gate — local and
 * .github/workflows/ci.yml — starts here.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const TEST_FILE_RE = /\.test\.tsx?$/;
const SEARCH_DIRS = ['src', 'scripts'];

/** Above ~6 workers the processes only fight over the CPUs (8 → 64 s, 12 → 72 s). */
const MAX_CONCURRENCY = 6;
const MAX_OVERRIDE_CONCURRENCY = 64;
const DEFAULT_STALL_MS = 4 * 60 * 1000;
const MIN_STALL_MS = 1000;
const HARD_LIMIT_MS = 30 * 60 * 1000;
const WATCH_INTERVAL_MS = 1000;

/** Sorted absolute paths of every test file below `root`/`searchDirs`. */
function discoverTestFiles({ root = ROOT, searchDirs = SEARCH_DIRS } = {}) {
  const seen = new Set();
  const testFiles = [];
  for (const dir of searchDirs) {
    const absDir = path.join(root, dir);
    if (!fs.existsSync(absDir)) continue;
    const stack = [absDir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
          if (!seen.has(full)) {
            seen.add(full);
            testFiles.push(full);
          }
        }
      }
    }
  }
  testFiles.sort();
  return testFiles;
}

function readPositiveInteger(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * `WHALE_TEST_CONCURRENCY` wins (1 = the strictly serial run). The default
 * halves the CPU count so the machine stays usable: a good share of the suite
 * waits on timers rather than on the CPU, which is why even 2 workers help.
 */
function resolveConcurrency({
  env = process.env,
  cpuCount = os.availableParallelism(),
} = {}) {
  const raw = env.WHALE_TEST_CONCURRENCY;
  if (raw !== undefined && String(raw).trim() !== '') {
    const value = readPositiveInteger('WHALE_TEST_CONCURRENCY', raw);
    if (value > MAX_OVERRIDE_CONCURRENCY) {
      throw new Error(
        `WHALE_TEST_CONCURRENCY must not exceed ${MAX_OVERRIDE_CONCURRENCY}, got ${value}`
      );
    }
    return value;
  }
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.ceil(cpuCount / 2)));
}

/** `WHALE_TEST_STALL_MS` may lengthen (or, for a probe, shorten) the watchdog. */
function resolveStallMs({ env = process.env } = {}) {
  const raw = env.WHALE_TEST_STALL_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_STALL_MS;
  return Math.max(MIN_STALL_MS, readPositiveInteger('WHALE_TEST_STALL_MS', raw));
}

/** Electron CLI arguments for one run of `testFiles`. */
function buildArgs(testFiles, concurrency) {
  return [
    '--test',
    `--test-concurrency=${concurrency}`,
    // Piped output is not a TTY: name the reporter so the `ℹ tests …` summary
    // stays identical in a terminal, in a CI log and after a redirect.
    '--test-reporter=spec',
    '--require',
    'ts-node/register',
    '--require',
    'tsconfig-paths/register',
    '--require',
    path.resolve(ROOT, 'scripts/test-asset-stub.cjs'),
    ...testFiles,
  ];
}

/** Kills `child` together with every process it started (the per-file runners). */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    return;
  }
  // POSIX: the child leads its own process group (spawned detached), so the
  // signal reaches the whole tree.
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function forward(source, target, onOutput) {
  source.on('data', (chunk) => {
    onOutput();
    if (target.destroyed) return;
    if (!target.write(chunk)) {
      // Backpressure: hold the child instead of buffering its output in memory.
      source.pause();
      target.once('drain', () => source.resume());
    }
  });
}

/**
 * Runs one suite. Resolves with `{ status, stalled, hardTimedOut, error }`:
 * `status` is the runner's exit code (null when it was killed or never
 * started), `stalled` when the watchdog had to kill it.
 */
function runSuite({
  command,
  args,
  cwd = ROOT,
  env = process.env,
  stallMs = DEFAULT_STALL_MS,
  hardLimitMs = HARD_LIMIT_MS,
  watchIntervalMs = WATCH_INTERVAL_MS,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  return new Promise((resolve) => {
    let lastOutputAt = Date.now();
    let stalled = false;
    let hardTimedOut = false;
    let settled = false;
    let watch;
    let hard;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: '1',
          TS_NODE_TRANSPILE_ONLY: 'true',
        },
      });
    } catch (error) {
      resolve({ status: null, stalled: false, hardTimedOut: false, error });
      return;
    }

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      clearTimeout(hard);
      resolve(outcome);
    };
    const onOutput = () => {
      lastOutputAt = Date.now();
    };

    forward(child.stdout, stdout, onOutput);
    forward(child.stderr, stderr, onOutput);
    watch = setInterval(() => {
      if (Date.now() - lastOutputAt >= stallMs) {
        stalled = true;
        killTree(child);
      }
    }, watchIntervalMs);
    hard = setTimeout(() => {
      hardTimedOut = true;
      killTree(child);
    }, hardLimitMs);
    // A hard limit only matters while the suite runs.
    hard.unref();
    watch.unref();

    child.on('error', (error) => {
      finish({ status: null, stalled: false, hardTimedOut: false, error });
    });
    child.on('close', (code) => {
      finish({
        status: stalled || hardTimedOut ? null : code,
        stalled,
        hardTimedOut,
        error: undefined,
      });
    });
  });
}

async function main() {
  let testFiles;
  try {
    testFiles = discoverTestFiles();
  } catch (error) {
    console.error(`run-tests: ${error.message}`);
    return 1;
  }
  if (testFiles.length === 0) {
    console.error('run-tests: no test files discovered under src/ or scripts/.');
    return 1;
  }

  let concurrency;
  let stallMs;
  try {
    concurrency = resolveConcurrency();
    stallMs = resolveStallMs();
  } catch (error) {
    console.error(`run-tests: ${error.message}`);
    return 1;
  }

  // `require('electron')` resolves to the path of the Electron binary when this
  // file is executed by plain Node (not from inside an Electron process).
  const electronBin = require('electron');

  // A wrong-ABI native module would fail dozens of tests with the same error;
  // report it once, with its fix, before spending minutes on the suite.
  const native = require('./check-native-abi.cjs').checkNativeAbi({ electronBin });
  if (!native.ok) {
    console.error(
      require('./check-native-abi.cjs').describeFailure(native, { label: 'run-tests' })
    );
    return 1;
  }

  console.log(
    `run-tests: discovered ${testFiles.length} test file(s), concurrency ${concurrency}.`
  );
  const first = await runSuite({ command: electronBin, args: buildArgs(testFiles, concurrency), stallMs });
  if (first.error) {
    console.error(`run-tests: failed to spawn electron: ${first.error.message}`);
    return 1;
  }
  if (first.hardTimedOut) {
    console.error('run-tests: the suite exceeded the 30 minute limit and was killed.');
    return 1;
  }
  if (!first.stalled) return first.status ?? 1;

  console.error(
    `\nrun-tests: no output for ${Math.round(stallMs / 1000)} s with concurrency ${concurrency}` +
      ' — the run was killed and is now repeated serially (WHALE_TEST_CONCURRENCY=1).'
  );
  const retry = await runSuite({ command: electronBin, args: buildArgs(testFiles, 1), stallMs });
  if (retry.error) {
    console.error(`run-tests: failed to spawn electron: ${retry.error.message}`);
    return 1;
  }
  if (retry.stalled) {
    console.error('run-tests: the serial run stalled as well — a test hangs on its own.');
    return 1;
  }
  if (retry.hardTimedOut) {
    console.error('run-tests: the suite exceeded the 30 minute limit and was killed.');
    return 1;
  }
  return retry.status ?? 1;
}

module.exports = {
  DEFAULT_STALL_MS,
  HARD_LIMIT_MS,
  MAX_CONCURRENCY,
  buildArgs,
  discoverTestFiles,
  resolveConcurrency,
  resolveStallMs,
  runSuite,
};

if (require.main === module) {
  // `process.exitCode` rather than `process.exit()`: the suite's output is
  // forwarded through this process, and a pipe on Windows flushes
  // asynchronously — exiting at once could drop the tail of the log.
  main().then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(`run-tests: ${error instanceof Error ? error.stack ?? error.message : error}`);
      process.exitCode = 1;
    }
  );
}
