import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { substituteAndQuote, runUserCommand } from './shell-command';
import { setAllowedRoots } from './allowed-roots';
import { COMMAND_PATH_BLOCKED } from '../shared/shell-types';

/**
 * User-command substitution + validation. `substituteAndQuote` is pure and is
 * exercised across path shapes (spaces, quotes, `%`, multiple placeholders).
 * `runUserCommand`'s validation branches (out-of-root refusal, Windows `%`
 * rejection) are covered here; the actual terminal spawn is verified by the
 * manual dev smoke rather than a fragile `child_process` mock.
 */
describe('substituteAndQuote', () => {
  it('quotes ${path} (POSIX)', () => {
    assert.equal(
      substituteAndQuote(
        'python process.py ${path}',
        { path: '/root/data.csv', dir: '/root', name: 'data.csv' },
        'linux'
      ),
      "python process.py '/root/data.csv'"
    );
  });

  it('quotes a path with spaces', () => {
    assert.equal(
      substituteAndQuote(
        'echo ${path}',
        { path: '/root/my data.csv', dir: '/root', name: 'my data.csv' },
        'linux'
      ),
      "echo '/root/my data.csv'"
    );
  });

  it('substitutes all three placeholders', () => {
    const out = substituteAndQuote(
      'cp ${path} ${dir}/${name}.bak',
      { path: '/root/a.txt', dir: '/root', name: 'a.txt' },
      'linux'
    );
    // Each placeholder is quoted independently, then concatenated by the
    // shell: '/root' + / + 'a.txt' + .bak → /root/a.txt.bak (valid shell).
    assert.equal(out, "cp '/root/a.txt' '/root'/'a.txt'.bak");
  });

  it('on Windows double-quotes a path with a space, leaves a plain one bare', () => {
    assert.equal(
      substituteAndQuote(
        'python ${path}',
        { path: 'C:\\my dir\\data.csv', dir: 'C:\\my dir', name: 'data.csv' },
        'win32'
      ),
      'python "C:\\my dir\\data.csv"'
    );
    assert.equal(
      substituteAndQuote(
        'python ${path}',
        { path: 'C:\\data.csv', dir: 'C:\\', name: 'data.csv' },
        'win32'
      ),
      'python C:\\data.csv'
    );
  });

  it('leaves a template with no placeholder unchanged', () => {
    assert.equal(
      substituteAndQuote(
        'echo hello',
        { path: '/x', dir: '/', name: 'x' },
        'linux'
      ),
      'echo hello'
    );
  });
});

describe('runUserCommand — validation', () => {
  it('refuses when no roots are configured (fail-closed)', async () => {
    setAllowedRoots([]);
    await assert.rejects(
      () => runUserCommand('echo ${path}', '/whatever/x.txt'),
      /Refused/
    );
  });

  it('refuses a path outside the configured root', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shell-'));
    try {
      setAllowedRoots([tempDir]);
      const outside = path.join(os.tmpdir(), 'whale-outside-' + Date.now() + '.txt');
      await assert.rejects(
        () => runUserCommand('echo ${path}', outside),
        /Refused|outside/i
      );
    } finally {
      setAllowedRoots([]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a Windows path containing % (COMMAND_PATH_BLOCKED)', async () => {
    // cmd.exe expands %VAR% even inside double quotes; there's no reliable
    // escape at `cmd /k`, so such paths are refused before spawning.
    if (process.platform !== 'win32') return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shell-'));
    try {
      setAllowedRoots([tempDir]);
      const target = path.join(tempDir, 'bad%name.txt');
      await assert.rejects(
        () => runUserCommand('echo ${path}', target),
        (err: Error) => err.message === COMMAND_PATH_BLOCKED
      );
    } finally {
      setAllowedRoots([]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
