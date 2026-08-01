import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatCombo } from './md-keybindings';

describe('formatCombo', () => {
  it('renders Mod-<key> as Ctrl+<key> (or ⌘ on mac)', () => {
    assert.equal(formatCombo('Mod-s', false), 'Ctrl+s');
    assert.equal(formatCombo('Mod-s', true), '⌘+s');
  });

  it('renders a Shift combo', () => {
    assert.equal(formatCombo('Mod-Shift-s', false), 'Ctrl+Shift+s');
    assert.equal(formatCombo('Mod-Shift-z', true), '⌘+Shift+z');
  });

  it('keeps a literal "=" key', () => {
    assert.equal(formatCombo('Mod-=', false), 'Ctrl+=');
  });

  it('keeps a literal "-" key (the bug: was rendered as Ctrl++)', () => {
    // Mod-- is Ctrl+minus. The old blanket `replace(/-/g, '+')` turned the
    // literal minus into a plus, so "Decrease heading" showed Ctrl++ instead
    // of Ctrl+- in the settings panel.
    assert.equal(formatCombo('Mod--', false), 'Ctrl+-');
    assert.equal(formatCombo('Mod-Shift--', false), 'Ctrl+Shift+-');
  });

  it('returns "" for an empty (unbound) combo', () => {
    assert.equal(formatCombo('', false), '');
  });
});
