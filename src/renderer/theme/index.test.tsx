import globalJsdom from 'global-jsdom';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@testing-library/react';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { createWhaleTheme } from './index';

let cleanupDom: (() => void) | undefined;

/** All CSS emotion has emitted into the jsdom document so far. */
function emittedCss(): string {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join('\n');
}

before(() => {
  cleanupDom = globalJsdom();
});

after(() => {
  cleanup();
  cleanupDom?.();
});

describe('createWhaleTheme', () => {
  it('downgrades animation and transition durations for reduced motion', () => {
    // WCAG 2.3.3: the OS preference must reach the whole app, including the
    // MUI transitions and the hand-written hover transforms. CssBaseline
    // carries the global rule, so mount it the way Root.tsx does.
    render(
      <ThemeProvider theme={createWhaleTheme('light', 'whale')}>
        <CssBaseline />
      </ThemeProvider>
    );

    const css = emittedCss().replace(/\s+/g, ' ');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /animation-duration: 0\.01ms !important/);
    assert.match(css, /transition-duration: 0\.01ms !important/);
    assert.match(css, /animation-iteration-count: 1 !important/);
    assert.match(css, /scroll-behavior: auto !important/);
  });
});
