import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { quotePathForShell } from './shell-quote';

/**
 * Path quoting for the user-command feature. The path the user right-clicks is
 * the untrusted input, so it must be quoted before landing in a shell string.
 * These lock the two platform branches (POSIX single-quote + Windows cmd
 * double-quote) that `substituteAndQuote` relies on.
 */
describe('quotePathForShell — POSIX (single-quote)', () => {
  it('wraps a plain path in single quotes', () => {
    assert.equal(quotePathForShell('/tmp/foo.txt', 'linux'), "'/tmp/foo.txt'");
  });

  it('keeps spaces verbatim inside the single quotes', () => {
    assert.equal(
      quotePathForShell('/tmp/my dir/foo.txt', 'linux'),
      "'/tmp/my dir/foo.txt'"
    );
  });

  it("close-reopens on an embedded single quote", () => {
    assert.equal(quotePathForShell("foo'bar", 'linux'), "'foo'\\''bar'");
  });

  it("returns '' for an empty value", () => {
    assert.equal(quotePathForShell('', 'linux'), "''");
  });
});

describe('quotePathForShell — Windows cmd (double-quote)', () => {
  it('returns a path with no special chars unchanged', () => {
    assert.equal(quotePathForShell('C:\\foo.txt', 'win32'), 'C:\\foo.txt');
  });

  it('double-quotes a path containing a space', () => {
    assert.equal(
      quotePathForShell('C:\\my dir\\foo.txt', 'win32'),
      '"C:\\my dir\\foo.txt"'
    );
  });

  it('doubles an embedded double-quote', () => {
    assert.equal(quotePathForShell('C:\\a"b', 'win32'), '"C:\\a""b"');
  });

  it('returns "" for an empty value', () => {
    assert.equal(quotePathForShell('', 'win32'), '""');
  });
});

describe('quotePathForShell — adversarial inputs (injection hardening)', () => {
  // The right-clicked path is the UNTRUSTED input; quoting is the only thing
  // between it and a shell string. These lock the contract against
  // shell-injection payloads, control characters, and the known Windows `%`
  // gap (which is defended upstream in `runUserCommand`, not here).

  it('POSIX: shell metacharacters stay literal inside single quotes', () => {
    // Inside `'…'` nothing is special, so every metacharacter must round-trip
    // verbatim rather than be expanded or executed.
    const metas = ['; rm -rf /', '& whoami', '| cat', '$HOME', '`id`', '(sub)', '<file', '>out'];
    for (const m of metas) {
      assert.equal(quotePathForShell(`/d/${m}`, 'linux'), `'/d/${m}'`, `meta=${m}`);
    }
  });

  it('POSIX: unicode (CJK) path is kept verbatim', () => {
    assert.equal(quotePathForShell('/笔记/截图.png', 'darwin'), "'/笔记/截图.png'");
  });

  it('POSIX: newline / tab / control characters stay literal', () => {
    // A literal newline inside single quotes does not break the command.
    assert.equal(quotePathForShell('a\nb\tc', 'linux'), "'a\nb\tc'");
  });

  it('POSIX: NUL byte stays literal (no truncation at the quote layer)', () => {
    assert.equal(quotePathForShell('a\x00b', 'linux'), "'a\x00b'");
  });

  it('POSIX: embedded single quote is close-reopened (neutralizes `;` injection)', () => {
    // The one character that MUST be handled — a bare `'` would end the
    // literal region. `a';echo pwned` must not become a second command.
    assert.equal(quotePathForShell("a';echo pwned", 'linux'), "'a'\\'';echo pwned'");
  });

  it('Windows: %VAR% is wrapped but `%` survives (defense is upstream)', () => {
    // quotePathForShell does NOT neutralize `%` — cmd still expands %PATH%
    // inside double quotes. The real guard is `runUserCommand` rejecting any
    // path containing `%` on Windows before it reaches here. This test pins
    // that contract so a future tweak to quoting alone isn't mistaken for a
    // fix to the `%` hole.
    assert.equal(
      quotePathForShell('C:\\dir\\%PATH%', 'win32'),
      '"C:\\dir\\%PATH%"',
      '% must survive quoting (upstream rejects it)'
    );
  });

  it('Windows: shell metacharacters each trigger quoting', () => {
    // Each of these is in WINDOWS_CMD_ARGUMENT_CHARS and must force a wrap.
    for (const ch of ['&', '|', '<', '>', '^', '(', ')', ';', '!', "'"]) {
      const q = quotePathForShell(`C:\\a${ch}b`, 'win32');
      assert.ok(q.startsWith('"') && q.endsWith('"'), `char=${ch} -> ${q}`);
    }
  });

  it('Windows: unicode path with a space is wrapped', () => {
    assert.equal(quotePathForShell('C:\\我的 文档\\x.txt', 'win32'), '"C:\\我的 文档\\x.txt"');
  });

  it('Windows: newline in path triggers quoting', () => {
    // A raw newline would split the cmd line; quoting at least contains it
    // within one token at this layer.
    const q = quotePathForShell('C:\\a\nb', 'win32');
    assert.ok(q.startsWith('"') && q.endsWith('"'));
  });
});
