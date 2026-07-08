import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installAnnotationsClient,
  readAnnotations,
  writeAnnotations,
  __resetForTests,
} from './annotations-client';
import { defaultEbookAnnotations } from '../../shared/ebook-annotations';

interface SentMessage {
  type: string;
  [k: string]: unknown;
}

/** Fake window.whaleExt + message bus for unit tests. */
function makeHarness() {
  __resetForTests();
  const sent: SentMessage[] = [];
  const handlers: Array<(msg: any) => void> = [];
  (globalThis as any).window = {
    whaleExt: {
      postMessage(msg: SentMessage) {
        sent.push(msg);
      },
    },
  };
  installAnnotationsClient((handler) => {
    handlers.push(handler);
    return () => {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  });
  return {
    sent,
    handlers,
    respond(msg: any) {
      for (const h of handlers) h(msg);
    },
  };
}

describe('annotations-client', () => {
  beforeEach(() => __resetForTests());

  it('readAnnotations posts a requestReadEbookAnnotations envelope', async () => {
    const h = makeHarness();
    const p = readAnnotations('/x/book.epub');
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].type, 'requestReadEbookAnnotations');
    assert.equal(h.sent[0].path, '/x/book.epub');
    assert.ok(typeof h.sent[0].requestId === 'string');
    // resolve the dangling promise so node:test does not warn
    h.respond({ type: 'ebookAnnotations', requestId: h.sent[0].requestId, ok: true, payload: null });
    await p;
  });

  it('resolves readAnnotations on matching response', async () => {
    const h = makeHarness();
    const expected = { ...defaultEbookAnnotations(), prefs: { ...defaultEbookAnnotations().prefs, fontSize: 22 } };
    const p = readAnnotations('/x/book.epub');
    const reqId = h.sent[0].requestId;
    h.respond({ type: 'ebookAnnotations', requestId: reqId, ok: true, payload: expected });
    const got = await p;
    assert.deepEqual(got, expected);
  });

  it('resolves readAnnotations to null when host reports no file', async () => {
    const h = makeHarness();
    const p = readAnnotations('/x/book.epub');
    h.respond({ type: 'ebookAnnotations', requestId: h.sent[0].requestId, ok: true, payload: null });
    const got = await p;
    assert.equal(got, null);
  });

  it('rejects readAnnotations when host returns an error', async () => {
    const h = makeHarness();
    const p = readAnnotations('/x/book.epub');
    h.respond({ type: 'ebookAnnotations', requestId: h.sent[0].requestId, ok: false, error: 'boom' });
    await assert.rejects(p, /boom/);
  });

  it('writeAnnotations resolves on matching response', async () => {
    const h = makeHarness();
    const p = writeAnnotations('/x/book.epub', defaultEbookAnnotations());
    h.respond({ type: 'ebookAnnotations', requestId: h.sent[0].requestId, ok: true });
    await p;
  });

  it('writeAnnotations rejects on error', async () => {
    const h = makeHarness();
    const p = writeAnnotations('/x/book.epub', defaultEbookAnnotations());
    h.respond({ type: 'ebookAnnotations', requestId: h.sent[0].requestId, ok: false, error: 'nope' });
    await assert.rejects(p, /nope/);
  });

  it('ignores responses for unknown request ids', () => {
    const h = makeHarness();
    // Should not throw.
    h.respond({ type: 'ebookAnnotations', requestId: 'never-issued', ok: true, payload: null });
  });
});