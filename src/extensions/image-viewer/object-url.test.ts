import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  createObjectUrlScope,
  imageBlobFor,
} from './object-url';

function stubScope() {
  const created: string[] = [];
  const revoked: string[] = [];
  let seq = 0;
  const scope = createObjectUrlScope({
    create: () => {
      seq += 1;
      const url = `blob:test/${seq}`;
      created.push(url);
      return url;
    },
    revoke: (url) => {
      revoked.push(url);
    },
  });
  return { scope, created, revoked };
}

describe('createObjectUrlScope', () => {
  it('returns the URL it created', () => {
    const { scope } = stubScope();
    const url = scope.replace(new Blob(['a']));
    assert.equal(url, 'blob:test/1');
    assert.equal(scope.current(), url);
  });

  it('revokes the previous URL when switching files', () => {
    const { scope, revoked } = stubScope();
    const first = scope.replace(new Blob(['a']));
    const second = scope.replace(new Blob(['b']));

    assert.deepEqual(revoked, [first]);
    assert.equal(scope.current(), second);
  });

  it('release() revokes once and is idempotent', () => {
    const { scope, revoked } = stubScope();
    const url = scope.replace(new Blob(['a']));

    scope.release();
    scope.release();

    assert.deepEqual(revoked, [url]);
    assert.equal(scope.current(), null);
  });

  it('does not revoke anything when nothing was ever created', () => {
    const { scope, revoked } = stubScope();
    scope.release();
    assert.deepEqual(revoked, []);
  });

  it('can create a new URL after release (reopening the same tab)', () => {
    const { scope, revoked, created } = stubScope();
    const first = scope.replace(new Blob(['a']));
    scope.release();
    const second = scope.replace(new Blob(['a']));

    assert.notEqual(first, second);
    assert.deepEqual(created, [first, second]);
    assert.deepEqual(revoked, [first]);
  });
});

describe('base64ToBytes', () => {
  it('decodes a padded payload', () => {
    // "Man" -> TWFu ; "Ma" -> TWE= ; "M" -> TQ==
    assert.deepEqual(Array.from(base64ToBytes('TWFu')), [0x4d, 0x61, 0x6e]);
    assert.deepEqual(Array.from(base64ToBytes('TWE=')), [0x4d, 0x61]);
    assert.deepEqual(Array.from(base64ToBytes('TQ==')), [0x4d]);
  });

  it('ignores the line breaks a host may wrap the payload with', () => {
    assert.deepEqual(Array.from(base64ToBytes('TWFu\nTWE=\r\n')), [
      0x4d, 0x61, 0x6e, 0x4d, 0x61,
    ]);
  });

  it('decodes binary bytes above 0x7f', () => {
    assert.deepEqual(Array.from(base64ToBytes('/w==')), [0xff]);
    assert.deepEqual(Array.from(base64ToBytes('AAEC')), [0, 1, 2]);
  });

  it('throws on a malformed payload (the caller reports it)', () => {
    assert.throws(() => base64ToBytes('!!!!'));
  });
});

describe('imageBlobFor', () => {
  it('carries the mime type and the decoded bytes', () => {
    const blob = imageBlobFor('TWFu', 'image/png');
    assert.equal(blob.type, 'image/png');
    assert.equal(blob.size, 3);
  });
});
