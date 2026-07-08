import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

import { checkReadOnlyGuard } from './readOnlyGuard';

/**
 * The guard leans on `isPathWithinDirectory`, which resolves realpaths; use
 * real temp directories so the within-directory check is unambiguous (no
 * dependence on drive letters or machine layout).
 */
describe('checkReadOnlyGuard', () => {
  let roRoot: string; // a "read-only" location root
  let rwRoot: string; // a writable location root
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  before(async () => {
    roRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ro-'));
    rwRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-rw-'));
    // isPathWithinDirectory compares case-insensitively on win32 and
    // case-sensitively elsewhere; force win32 semantics so the assertions are
    // stable regardless of the test host. (The guard has no platform branch of
    // its own — normalization lives in utils/path.)
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  after(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('denies a Write tool whose target is inside a read-only root', () => {
    const target = path.join(roRoot, 'sub', 'file.txt');
    const result = checkReadOnlyGuard(
      'Write',
      { file_path: target },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, true);
    assert.match(result.reason ?? '', /read-only/);
  });

  it('allows a Write tool whose target is inside a writable root', () => {
    const target = path.join(rwRoot, 'file.txt');
    const result = checkReadOnlyGuard(
      'Write',
      { file_path: target },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, false);
  });

  it('denies Bash when the working directory is a read-only root', () => {
    const result = checkReadOnlyGuard(
      'Bash',
      { command: 'ls' },
      { readOnlyRoots: [roRoot], cwd: roRoot }
    );
    assert.equal(result.deny, true);
  });

  it('allows Bash when the working directory is writable', () => {
    const result = checkReadOnlyGuard(
      'Bash',
      { command: 'ls' },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, false);
  });

  it('always allows read-only tools (Read) even inside a read-only root', () => {
    const target = path.join(roRoot, 'file.txt');
    const result = checkReadOnlyGuard(
      'Read',
      { file_path: target },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, false);
  });

  it('uses notebook_path for NotebookEdit', () => {
    const target = path.join(roRoot, 'nb.ipynb');
    const result = checkReadOnlyGuard(
      'NotebookEdit',
      { notebook_path: target },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, true);
  });

  it('denies apply_tag on a file inside a read-only root (reads "path")', () => {
    const target = path.join(roRoot, 'doc.md');
    const result = checkReadOnlyGuard(
      'apply_tag',
      { path: target, tag: 'workflow:in-progress', mode: 'add' },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, true);
    assert.match(result.reason ?? '', /read-only/);
  });

  it('allows apply_tag on a file inside a writable root', () => {
    const target = path.join(rwRoot, 'doc.md');
    const result = checkReadOnlyGuard(
      'apply_tag',
      { path: target, tag: 'idea' },
      { readOnlyRoots: [roRoot], cwd: rwRoot }
    );
    assert.equal(result.deny, false);
  });
});
