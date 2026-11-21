#!/usr/bin/env node
/**
 * Test runner entry point.
 *
 * Auto-discovers every `*.test.ts` / `*.test.tsx` under `src/` and `scripts/`
 * and runs them through Electron's `--test` (Node's built-in test runner, with
 * ts-node for on-the-fly transpilation).
 *
 * This replaces the hand-maintained explicit file list that used to live inline
 * in the package.json `test` script. That list had drifted: 8 test files were
 * never listed (so they silently never ran) and 1 phantom entry pointed at a
 * non-existent file. Auto-discovery means new tests always run with zero
 * package.json edits.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Deliberately dependency-free. Discovery used to `require('glob')`, which was
// never declared in package.json — it only worked because a transitive dev
// dependency happened to be hoisted. If that ever changed, `npm test` would die
// with MODULE_NOT_FOUND, and this repo has no CI: type-check/lint/test ARE the
// gate. A 15-line walker removes the single point of failure.
const TEST_FILE_RE = /\.test\.tsx?$/;
const SEARCH_DIRS = ['src', 'scripts'];

const seen = new Set();
const testFiles = [];
for (const dir of SEARCH_DIRS) {
  const absDir = path.join(ROOT, dir);
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

if (testFiles.length === 0) {
  console.error('run-tests: no test files discovered under src/ or scripts/.');
  process.exit(1);
}

console.log(`run-tests: discovered ${testFiles.length} test file(s).`);

// `require('electron')` resolves to the path of the Electron binary when this
// file is executed by plain Node (not from inside an Electron process).
const electronBin = require('electron');

const result = spawnSync(
  electronBin,
  [
    '--test',
    // node:test's parallel scheduler deadlocks under Electron's single-process
    // model in this repo — serialize so the full suite runs reliably.
    '--test-concurrency=1',
    '--require', 'ts-node/register',
    '--require', 'tsconfig-paths/register',
    '--require', path.resolve(ROOT, 'scripts/test-asset-stub.cjs'),
    ...testFiles,
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    // Without a timeout a hung test (or a wedged Electron child) makes CI wait
    // forever; node:test has no built-in watchdog under this runner.
    timeout: 30 * 60 * 1000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TS_NODE_TRANSPILE_ONLY: 'true',
    },
  }
);

if (result.error) {
  const timedOut = result.error.code === 'ETIMEDOUT';
  console.error(
    timedOut
      ? 'run-tests: the suite exceeded the 30 minute limit and was killed.'
      : `run-tests: failed to spawn electron: ${result.error.message}`
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
