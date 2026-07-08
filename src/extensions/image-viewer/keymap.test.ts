/**
 * Unit tests for the image viewer's pure helpers (keymap, sibling nav,
 * pan clamp). Run under `node:test` via the repo's existing `npm test`
 * script — see `scripts/test-asset-stub.cjs` for the electron-runner
 * plumbing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { keymapAction, siblingTarget } from './keymap';

function ev(
  key: string,
  opts: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  return { key, ctrlKey: false, altKey: false, metaKey: false, ...opts } as KeyboardEvent;
}

describe('keymapAction', () => {
  it('maps arrow / page keys to nav', () => {
    const ctx = { hasSiblings: true, hasImage: true };
    assert.equal(keymapAction(ev('ArrowLeft'), ctx), 'prev');
    assert.equal(keymapAction(ev('ArrowRight'), ctx), 'next');
    assert.equal(keymapAction(ev('PageUp'), ctx), 'prev');
    assert.equal(keymapAction(ev('PageDown'), ctx), 'next');
    assert.equal(keymapAction(ev(' '), ctx), 'next');
    assert.equal(keymapAction(ev('Home'), ctx), 'first');
    assert.equal(keymapAction(ev('End'), ctx), 'last');
  });

  it('maps +/-/0/1 to zoom actions', () => {
    const ctx = { hasSiblings: true, hasImage: true };
    assert.equal(keymapAction(ev('+'), ctx), 'zoomIn');
    assert.equal(keymapAction(ev('='), ctx), 'zoomIn');
    assert.equal(keymapAction(ev('-'), ctx), 'zoomOut');
    assert.equal(keymapAction(ev('_'), ctx), 'zoomOut');
    assert.equal(keymapAction(ev('0'), ctx), 'reset');
    assert.equal(keymapAction(ev('1'), ctx), 'actualSize');
  });

  it('maps r/h/v/f to transform / fullscreen', () => {
    const ctx = { hasSiblings: true, hasImage: true };
    assert.equal(keymapAction(ev('r'), ctx), 'rotate');
    assert.equal(keymapAction(ev('R'), ctx), 'rotate');
    assert.equal(keymapAction(ev('h'), ctx), 'flipH');
    assert.equal(keymapAction(ev('H'), ctx), 'flipH');
    assert.equal(keymapAction(ev('v'), ctx), 'flipV');
    assert.equal(keymapAction(ev('V'), ctx), 'flipV');
    assert.equal(keymapAction(ev('f'), ctx), 'fullscreen');
    assert.equal(keymapAction(ev('F'), ctx), 'fullscreen');
  });

  it('gates nav on hasSiblings', () => {
    const ctx = { hasSiblings: false, hasImage: true };
    assert.equal(keymapAction(ev('ArrowLeft'), ctx), null);
    assert.equal(keymapAction(ev('ArrowRight'), ctx), null);
    assert.equal(keymapAction(ev(' '), ctx), null);
    assert.equal(keymapAction(ev('+'), ctx), 'zoomIn');
  });

  it('gates image actions on hasImage', () => {
    const ctx = { hasSiblings: true, hasImage: false };
    assert.equal(keymapAction(ev('+'), ctx), null);
    assert.equal(keymapAction(ev('0'), ctx), null);
    assert.equal(keymapAction(ev('r'), ctx), null);
    assert.equal(keymapAction(ev('f'), ctx), null);
    // nav is still image-independent (siblings are known up front)
    assert.equal(keymapAction(ev('ArrowRight'), ctx), 'next');
  });

  it('ignores modifier keys', () => {
    const ctx = { hasSiblings: true, hasImage: true };
    assert.equal(keymapAction(ev('0', { ctrlKey: true }), ctx), null);
    assert.equal(keymapAction(ev('r', { metaKey: true }), ctx), null);
    assert.equal(keymapAction(ev('+', { altKey: true }), ctx), null);
  });

  it('returns null for unhandled keys', () => {
    const ctx = { hasSiblings: true, hasImage: true };
    assert.equal(keymapAction(ev('a'), ctx), null);
    assert.equal(keymapAction(ev('z'), ctx), null);
    assert.equal(keymapAction(ev('Enter'), ctx), null);
    assert.equal(keymapAction(ev('Tab'), ctx), null);
  });
});

describe('siblingTarget', () => {
  const paths = ['/a.png', '/b.png', '/c.png'];

  it('wraps prev / next at both ends', () => {
    assert.equal(siblingTarget(paths, '/a.png', 'prev'), '/c.png');
    assert.equal(siblingTarget(paths, '/c.png', 'next'), '/a.png');
    assert.equal(siblingTarget(paths, '/b.png', 'prev'), '/a.png');
    assert.equal(siblingTarget(paths, '/b.png', 'next'), '/c.png');
  });

  it('returns first / last directly', () => {
    assert.equal(siblingTarget(paths, '/b.png', 'first'), '/a.png');
    assert.equal(siblingTarget(paths, '/b.png', 'last'), '/c.png');
  });

  it('falls back to first / last when current is not in the list', () => {
    assert.equal(siblingTarget(paths, '/missing.png', 'next'), '/a.png');
    assert.equal(siblingTarget(paths, '/missing.png', 'prev'), '/a.png');
    assert.equal(siblingTarget(paths, '/missing.png', 'last'), '/c.png');
  });

  it('handles single-element lists without breaking', () => {
    assert.equal(siblingTarget(['/only.png'], '/only.png', 'next'), '/only.png');
    assert.equal(siblingTarget(['/only.png'], '/only.png', 'prev'), '/only.png');
  });

  it('returns null for empty lists', () => {
    assert.equal(siblingTarget([], '/x', 'next'), null);
  });
});
