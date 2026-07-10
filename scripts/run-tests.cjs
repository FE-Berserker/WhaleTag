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
const { spawnSync } = require('child_process');
const path = require('path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'scripts/**/*.test.ts',
  'scripts/**/*.test.tsx',
];

const seen = new Set();
const testFiles = [];
for (const pattern of PATTERNS) {
  for (const abs of glob.sync(pattern, {
    cwd: ROOT,
    absolute: true,
    ignore: ['**/node_modules/**'],
  })) {
    if (!seen.has(abs)) {
      seen.add(abs);
      testFiles.push(abs);
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
    '--require', 'ts-node/register',
    '--require', 'tsconfig-paths/register',
    '--require', path.resolve(ROOT, 'scripts/test-asset-stub.cjs'),
    ...testFiles,
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TS_NODE_TRANSPILE_ONLY: 'true',
    },
  }
);

if (result.error) {
  console.error('run-tests: failed to spawn electron:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
