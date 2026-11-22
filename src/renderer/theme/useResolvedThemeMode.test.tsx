import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, renderHook } from '@testing-library/react';

import type { ThemeMode } from '-/reducers/settings';
import {
  useResolvedTheme,
  useResolvedThemeMode,
} from './useResolvedThemeMode';

let cleanupDom: (() => void) | undefined;

before(() => {
  cleanupDom = globalJsdom();
});
afterEach(() => cleanup());
after(() => cleanupDom?.());

describe('resolved theme corrupt persisted input', () => {
  it('falls back to classic light + whale instead of returning undefined', () => {
    for (const persisted of [
      'future-theme',
      '__proto__',
      'constructor',
      '',
      undefined,
      null,
      42,
    ]) {
      const mode = persisted as ThemeMode;
      const full = renderHook(() => useResolvedTheme(mode));
      assert.deepEqual(full.result.current, {
        mode: 'light',
        presetId: 'whale',
      });
      full.unmount();

      const shorthand = renderHook(() => useResolvedThemeMode(mode));
      assert.equal(shorthand.result.current, 'light');
      shorthand.unmount();
    }
  });

  it('still resolves a supported curated mode to its fixed pair', () => {
    const { result } = renderHook(() => useResolvedTheme('frosted-mint'));
    assert.deepEqual(result.current, {
      mode: 'light',
      presetId: 'frosted-mint',
    });
  });
});
