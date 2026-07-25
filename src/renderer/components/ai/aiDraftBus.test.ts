import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';

import {
  AI_DRAFT_EVENT,
  consumeAiDraft,
  postAiDraft,
} from './aiDraftBus';

describe('aiDraftBus', () => {
  it('delivers via the event AND keeps a pending copy for lazy mounts', () => {
    globalJsdom();
    let got: unknown = null;
    window.addEventListener(AI_DRAFT_EVENT, (e) => {
      got = (e as CustomEvent).detail;
    });
    postAiDraft({ path: '/a.pdf', page: 3, text: 'hello' });
    assert.deepEqual(got, { path: '/a.pdf', page: 3, text: 'hello' });
    // The pending slot survives until drained — this is what rescues the
    // draft when AiPanel's lazy chunk finishes loading after the event.
    assert.deepEqual(consumeAiDraft(), {
      path: '/a.pdf',
      page: 3,
      text: 'hello',
    });
    assert.equal(consumeAiDraft(), null);
  });

  it('a second post overwrites an unconsumed draft (last wins)', () => {
    globalJsdom();
    postAiDraft({ path: '/a.pdf', text: 'first' });
    postAiDraft({ path: '/b.pdf', text: 'second' });
    assert.deepEqual(consumeAiDraft(), { path: '/b.pdf', text: 'second' });
    assert.equal(consumeAiDraft(), null);
  });
});
