#!/usr/bin/env node
/**
 * Native-module ABI check.
 *
 * better-sqlite3 is a V8-bound addon (not N-API): the binary that loads it and
 * the binary it was built for must share one ABI. Everything in this repo
 * loads it from Electron (module ABI 146 for Electron 42), but `npm ci` /
 * `npm install` fetches the prebuilt binary for the PLAIN Node that runs npm —
 * prebuild-install targets the running Node (ABI 137 for Node 24, 127 for
 * Node 22). Such a checkout only fails on first use: every index-related test
 * errors with "NODE_MODULE_VERSION", and the app fails when it opens the index.
 *
 * Fix in that case:   npx electron-rebuild -f -o better-sqlite3
 *
 * Runs before the test suite (`scripts/run-tests.cjs`) and before `npm run
 * dev` (`predev`), so the mismatch is reported once, with its fix.
 */
'use strict';

const childProcess = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The ABI-bound addons of the dependency tree (N-API addons are portable). */
const ABI_BOUND_MODULES = ['better-sqlite3'];

/**
 * Loads every ABI-bound addon inside Electron (as Node) and reports the outcome.
 * `electronBin` is passed in because `require('electron')` means something
 * else once this file is loaded from inside Electron itself.
 */
function checkNativeAbi({
  cwd = ROOT,
  electronBin,
  env = process.env,
  timeoutMs = 60 * 1000,
  spawn = childProcess.spawnSync,
} = {}) {
  const script =
    ABI_BOUND_MODULES.map((name) => `require(${JSON.stringify(name)});`).join(' ') +
    'console.log(process.versions.modules);';
  const probe = spawn(electronBin, ['-e', script], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (probe.error) {
    return {
      ok: false,
      electronAbi: undefined,
      builtForOtherRuntime: false,
      reason: `could not start Electron: ${probe.error.message}`,
    };
  }
  if (probe.status === 0) {
    return { ok: true, electronAbi: (probe.stdout || '').trim(), builtForOtherRuntime: false, reason: '' };
  }
  const stderr = probe.stderr || '';
  const versionLine = stderr.match(/NODE_MODULE_VERSION[^\r\n]*/);
  const firstError = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return {
    ok: false,
    electronAbi: undefined,
    builtForOtherRuntime: /NODE_MODULE_VERSION|was compiled against/i.test(stderr),
    reason:
      (versionLine ? versionLine[0] : '') ||
      firstError ||
      `electron exited with status ${probe.status}`,
  };
}

/** The user-facing explanation with the fix. */
function describeFailure(result, { label = 'check-native-abi', modules = ABI_BOUND_MODULES } = {}) {
  const lines = [`${label}: a native module cannot be loaded by this Electron.`];
  for (const name of modules) lines.push(`  ${name}: ${result.reason}`);
  if (result.builtForOtherRuntime) {
    lines.push(
      '  It was built for plain Node, not for Electron (npm ci / npm install fetch',
      '  the build for the Node that runs npm). Rebuild it for Electron:',
      '',
      `    npx electron-rebuild -f -o ${modules.join(' ')}`
    );
  }
  return lines.join('\n');
}

module.exports = { ABI_BOUND_MODULES, checkNativeAbi, describeFailure };

if (require.main === module) {
  const electronBin = require('electron');
  const result = checkNativeAbi({ electronBin });
  if (!result.ok) {
    console.error(describeFailure(result));
    process.exit(1);
  }
}
