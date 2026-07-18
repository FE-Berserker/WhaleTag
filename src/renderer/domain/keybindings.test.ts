import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEYBINDINGS,
  MAPPABLE_KEYS,
  CYCLABLE_VIEWS,
  normalizeKey,
  resolveAction,
  nextView,
  sanitizeKeybindings,
} from './keybindings';

describe('keybindings.normalizeKey', () => {
  it("canonicalizes ' ' (space) to 'Space'", () => {
    assert.equal(normalizeKey({ key: ' ' }), 'Space');
  });

  it("canonicalizes legacy 'Spacebar' to 'Space'", () => {
    assert.equal(normalizeKey({ key: 'Spacebar' }), 'Space');
  });

  it('passes other keys through verbatim', () => {
    assert.equal(normalizeKey({ key: 'Enter' }), 'Enter');
    assert.equal(normalizeKey({ key: 'ArrowUp' }), 'ArrowUp');
    assert.equal(normalizeKey({ key: 'F2' }), 'F2');
  });
});

describe('keybindings.resolveAction', () => {
  it('returns the bound action for a token', () => {
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: 'ArrowRight' }),
      'open'
    );
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: 'Tab' }),
      'switchView'
    );
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: 'ArrowLeft' }),
      'back'
    );
  });

  it("lets two keys share one action (Enter + ArrowRight → 'open')", () => {
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: 'Enter' }),
      'open'
    );
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: 'ArrowRight' }),
      'open'
    );
  });

  it('honors the space normalization on the way in', () => {
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: ' ' }),
      'toggleSelect'
    );
  });

  it('returns null for an unmapped key', () => {
    assert.equal(
      resolveAction(DEFAULT_KEYBINDINGS, { key: 'Unbound' }),
      null
    );
  });

  it('returns null when the bindings map is empty', () => {
    assert.equal(resolveAction({}, { key: 'ArrowUp' }), null);
  });

  it("treats a key bound to 'none' as unbound (defensive)", () => {
    // sanitizeKeybindings strips 'none' entries, but resolveAction must also
    // defend against a map that still carries one.
    assert.equal(
      resolveAction({ ArrowUp: 'none' }, { key: 'ArrowUp' }),
      null
    );
  });
});

describe('keybindings.nextView', () => {
  it('advances one step through the cycle', () => {
    assert.equal(nextView('list'), 'grid');
    assert.equal(nextView('grid'), 'gallery');
  });

  it('wraps from the last view back to the first', () => {
    assert.equal(nextView('knowledge-graph'), 'list');
  });

  it('falls back to the first view for a value outside the cycle', () => {
    // 'mindmap' is a legacy alias rewritten on read; it's not in CYCLABLE_VIEWS.
    assert.equal(nextView('mindmap' as never), 'list');
  });

  it('CYCLABLE_VIEWS length matches the 9 header toggle buttons (H.29: kanban/matrix absorbed into task)', () => {
    assert.equal(CYCLABLE_VIEWS.length, 9);
  });
});

describe('keybindings.sanitizeKeybindings', () => {
  it('keeps valid token/action pairs', () => {
    assert.deepEqual(
      sanitizeKeybindings({ Enter: 'open', Tab: 'switchView' }),
      { Enter: 'open', Tab: 'switchView' }
    );
  });

  it('drops a token not in MAPPABLE_KEYS', () => {
    assert.deepEqual(sanitizeKeybindings({ CtrlZ: 'open' }), {});
  });

  it('drops an unknown action value', () => {
    assert.deepEqual(sanitizeKeybindings({ Enter: 'fly' }), {});
  });

  it("drops a 'none' entry (equivalent to absent)", () => {
    assert.deepEqual(sanitizeKeybindings({ Enter: 'none' }), {});
  });

  it('keeps the good entries and drops the bad ones in a mixed map', () => {
    assert.deepEqual(
      sanitizeKeybindings({
        Enter: 'open',
        Bogus: 'x',
        Tab: 'none',
        ArrowLeft: 'back',
      }),
      { Enter: 'open', ArrowLeft: 'back' }
    );
  });

  it('returns a fresh copy of DEFAULT for non-object input', () => {
    const fromUndefined = sanitizeKeybindings(undefined);
    assert.deepEqual(fromUndefined, DEFAULT_KEYBINDINGS);
    assert.notEqual(fromUndefined, DEFAULT_KEYBINDINGS); // a copy, not the shared ref
    assert.deepEqual(sanitizeKeybindings(null), DEFAULT_KEYBINDINGS);
    assert.deepEqual(sanitizeKeybindings('not a map'), DEFAULT_KEYBINDINGS);
  });

  it('drops entries whose action is a non-string', () => {
    assert.deepEqual(
      sanitizeKeybindings({ Enter: 42, Tab: 'switchView' }),
      { Tab: 'switchView' }
    );
  });
});

describe('keybindings.MAPPABLE_KEYS / DEFAULT_KEYBINDINGS consistency', () => {
  it('every default token is a mappable key', () => {
    const valid = new Set(MAPPABLE_KEYS.map((k) => k.token));
    for (const token of Object.keys(DEFAULT_KEYBINDINGS)) {
      assert.ok(valid.has(token), `default token ${token} not in MAPPABLE_KEYS`);
    }
  });

  it('every mappable key has a default action', () => {
    for (const { token } of MAPPABLE_KEYS) {
      assert.ok(
        token in DEFAULT_KEYBINDINGS,
        `mappable key ${token} has no default action`
      );
    }
  });
});
