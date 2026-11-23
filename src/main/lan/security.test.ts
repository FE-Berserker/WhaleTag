import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentDisposition,
  decodeEntryId,
  encodeEntryId,
  EntryIdError,
  isAllowedOrigin,
  isPrivateAddress,
  normalizeAddress,
  parseLanRange,
  parseLiteralHost,
  secretsEqual,
} from './security';

describe('LAN network and path guards', () => {
  it('accepts only private/loopback addresses and normalizes mapped addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.2', '172.16.4.5', '192.168.1.8', '::1', 'fd00::1', 'fe80::1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2001:4860::1', '', undefined]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
    assert.equal(isPrivateAddress('::ffff:192.168.1.2'), true);
    assert.equal(normalizeAddress('[::FFFF:127.0.0.1]'), '127.0.0.1');
  });

  it('requires literal hosts and exact private origins', () => {
    assert.equal(parseLiteralHost('127.0.0.1:4321', 4321), '127.0.0.1');
    assert.equal(parseLiteralHost('[::1]:4321', 4321), '::1');
    assert.equal(parseLiteralHost('localhost:4321', 4321), null);
    assert.equal(parseLiteralHost('127.0.0.1:80', 4321), null);
    const allowed = new Set(['127.0.0.1', '192.168.1.2']);
    assert.equal(isAllowedOrigin('http://192.168.1.2:4321', 4321, allowed), true);
    assert.equal(isAllowedOrigin('http://192.168.1.2:4321/path', 4321, allowed), false);
    assert.equal(isAllowedOrigin('https://192.168.1.2:4321', 4321, allowed), false);
    assert.equal(isAllowedOrigin('http://example.com:4321', 4321, allowed), false);
  });

  it('uses timing-safe comparisons without throwing on unequal lengths', () => {
    assert.equal(secretsEqual('same-secret', 'same-secret'), true);
    assert.equal(secretsEqual('same-secret', 'other-secret'), false);
    assert.equal(secretsEqual('short', 'a-much-longer-secret'), false);
  });

  it('round-trips Unicode relative ids and rejects non-canonical traversal', () => {
    const relative = '目录/报告[重要].txt';
    assert.equal(decodeEntryId(encodeEntryId(relative)), relative);
    for (const invalid of [
      encodeEntryId('../outside.txt'),
      encodeEntryId('/absolute.txt'),
      encodeEntryId('C:\\outside.txt'),
      encodeEntryId('.whale/index.db'),
      encodeEntryId('a//b.txt'),
      'not canonical!',
      'A',
    ]) {
      assert.throws(() => decodeEntryId(invalid), EntryIdError, invalid);
    }
  });
});

describe('LAN Range and download headers', () => {
  it('parses bounded single and suffix ranges', () => {
    assert.deepEqual(parseLanRange('bytes=2-5', 10), { kind: 'range', start: 2, end: 5 });
    assert.deepEqual(parseLanRange('bytes=7-', 10), { kind: 'range', start: 7, end: 9 });
    assert.deepEqual(parseLanRange('bytes=-3', 10), { kind: 'range', start: 7, end: 9 });
    assert.deepEqual(parseLanRange('bytes=2-99', 10), { kind: 'range', start: 2, end: 9 });
  });

  it('distinguishes malformed syntax from unsatisfiable and multi ranges', () => {
    assert.deepEqual(parseLanRange('items=0-1', 10), { kind: 'malformed' });
    assert.deepEqual(parseLanRange('bytes=-', 10), { kind: 'malformed' });
    assert.deepEqual(parseLanRange('bytes=0-1,4-5', 10), { kind: 'unsatisfiable' });
    assert.deepEqual(parseLanRange('bytes=99-', 10), { kind: 'unsatisfiable' });
    assert.deepEqual(parseLanRange('bytes=0-0', 0), { kind: 'unsatisfiable' });
  });

  it('prevents response splitting and preserves a UTF-8 download name', () => {
    const header = contentDisposition('attachment', '报告"\r\n.txt');
    assert.ok(header.startsWith('attachment; filename="'));
    assert.equal(header.includes('\r'), false);
    assert.equal(header.includes('\n'), false);
    assert.ok(header.includes("filename*=UTF-8''"));
  });
});
