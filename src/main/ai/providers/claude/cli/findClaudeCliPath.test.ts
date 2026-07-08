import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

import { findClaudeCLIPath, __setFileCheckerForTest } from './findClaudeCliPath';

const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'claude.exe' : 'claude';

/**
 * findClaudeCLIPath probes many host-specific locations (homedir, npm global,
 * $PATH) and their precedence is environment-dependent. To make discovery
 * deterministic regardless of what's installed on the dev machine, we inject a
 * fake file-checker that reports ONLY the temp binary as existing. (Direct
 * `fs` mocking is impossible — the `import * as fs` namespace exposes its
 * bindings as non-configurable getters.)
 */
describe('findClaudeCLIPath', () => {
  const originalPath = process.env.PATH;
  let tmp: string;
  let binaryPath: string;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-cli-'));
    binaryPath = path.join(tmp, binaryName);
  });
  after(() => {
    process.env.PATH = originalPath;
  });

  it('discovers the binary via the PATH lookup branch', () => {
    const restore = __setFileCheckerForTest((p) => p === binaryPath);
    process.env.PATH = tmp;
    try {
      const found = findClaudeCLIPath(undefined);
      assert.equal(
        found && path.resolve(found),
        path.resolve(binaryPath),
        `expected ${binaryPath}, got ${found}`
      );
    } finally {
      restore();
      process.env.PATH = originalPath;
    }
  });

  it('honors an explicit settings override path', () => {
    const restore = __setFileCheckerForTest((p) => p === binaryPath);
    try {
      const found = findClaudeCLIPath(tmp);
      assert.equal(
        found && path.resolve(found),
        path.resolve(binaryPath),
        `override resolution expected ${binaryPath}, got ${found}`
      );
    } finally {
      restore();
    }
  });

  it('returns null when nothing exists', () => {
    const restore = __setFileCheckerForTest(() => false);
    process.env.PATH = path.join(os.tmpdir(), 'whale-cli-empty-' + process.pid);
    try {
      const found = findClaudeCLIPath(process.env.PATH);
      assert.equal(found, null);
    } finally {
      restore();
      process.env.PATH = originalPath;
    }
  });

  it('prefers the bundled @anthropic-ai/claude-code package when available', () => {
    // The real bundled package is installed in dev node_modules.
    const bundledPath = require.resolve(
      '@anthropic-ai/claude-code/package.json'
    );
    const bundledDir = path.dirname(bundledPath);
    const entry = path.join(bundledDir, 'cli-wrapper.cjs');
    // File checker: true ONLY for the bundled entrypoint.
    const restore = __setFileCheckerForTest((p) => p === entry);
    process.env.PATH = '';
    try {
      const found = findClaudeCLIPath(undefined);
      assert.equal(
        found && path.resolve(found),
        path.resolve(entry),
        `expected bundled ${entry}, got ${found}`
      );
    } finally {
      restore();
      process.env.PATH = originalPath;
    }
  });
});
