/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * text-editor — unit tests for editor-stats.ts pure helpers.
 *
 * Run via `npm test` (electron --test under node:test). Mirror of the test
 * pattern used by:
 *   - html-viewer/html-stats.test.ts
 *   - json-viewer/json-model.test.ts
 *   - image-viewer/keymap.test.ts
 *
 * All helpers here are DOM-free by design — except the localStorage helpers
 * which are guarded by try/catch and tested via a `globalThis.window`
 * stub when needed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';

import {
  STATUS_NO_VALUE,
  DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  FONT_SIZE_STEP,
  formatBytes,
  parseEncoding,
  getCursorPosition,
  clampFontSize,
  stepFontSize,
  loadFontSize,
  persistFontSize,
  loadWrapMode,
  persistWrapMode,
  supportsFolding,
  countMatches,
} from './editor-stats';

// --- localStorage stub ----------------------------------------------------
//
// loadFontSize / persistFontSize / loadWrapMode / persistWrapMode reach into
// `window.localStorage`. In the sandboxed test environment `window` may not
// exist, so we provide a minimal Map-backed stub. We restore the original
// after each test that mutates storage so other test files aren't affected.

function withStorage<T>(fn: () => T): T {
  const memStore = new Map<string, string>();
  const g = globalThis as any;
  const prevWindow = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
      setItem: (k: string, v: string) => {
        memStore.set(k, v);
      },
      removeItem: (k: string) => {
        memStore.delete(k);
      },
      clear: () => memStore.clear(),
      key: () => null,
      get length() {
        return memStore.size;
      },
    },
  };
  try {
    return fn();
  } finally {
    if (prevWindow === undefined) {
      delete g.window;
    } else {
      g.window = prevWindow;
    }
  }
}

// --- Tests ----------------------------------------------------------------

describe('formatBytes', () => {
  it('returns "0 B" for 0', () => {
    assert.equal(formatBytes(0), '0 B');
  });

  it('formats bytes (< 1 KB) without decimal', () => {
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  it('formats KB with one decimal', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 10), '10.0 KB');
  });

  it('formats MB with one decimal', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 5.25), '5.3 MB');
  });

  it('formats GB with two decimals', () => {
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
    assert.equal(formatBytes(1024 * 1024 * 1024 * 2), '2.00 GB');
  });

  it('handles non-finite / negative inputs gracefully', () => {
    assert.equal(formatBytes(NaN), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Infinity), '0 B');
  });
});

describe('parseEncoding', () => {
  it('maps utf8 → UTF-8', () => {
    assert.equal(parseEncoding('utf8'), 'UTF-8');
  });

  it('maps base64 → Base64', () => {
    assert.equal(parseEncoding('base64'), 'Base64');
  });
});

describe('getCursorPosition', () => {
  it('returns line 1, col 1 for an empty document', () => {
    const state = EditorState.create({ doc: '' });
    const stats = getCursorPosition(state);
    assert.equal(stats.line, 1);
    assert.equal(stats.col, 1);
    assert.equal(stats.docLength, 0);
    assert.equal(stats.selectionLength, 0);
  });

  it('positions cursor at line 1, col N for single-line content', () => {
    // EditorState.create defaults cursor to head=0 (start). Explicit selection
    // puts it at end of "hello" (pos 5 → line 1, col 6).
    const state = EditorState.create({
      doc: 'hello world',
      selection: { anchor: 5 },
    });
    const stats = getCursorPosition(state);
    assert.equal(stats.line, 1);
    assert.equal(stats.col, 6);
    assert.equal(stats.docLength, 11);
    assert.equal(stats.selectionLength, 0);
  });

  it('positions cursor on multi-line content', () => {
    const state = EditorState.create({ doc: 'a\nb\nc', selection: { anchor: 4 } });
    const stats = getCursorPosition(state);
    assert.equal(stats.line, 3);
    assert.equal(stats.col, 1);
    assert.equal(stats.docLength, 5);
    assert.equal(stats.selectionLength, 0);
  });

  it('measures selection length', () => {
    // Selection { anchor: 0, head: 5 }: cursor at end of "hello" (col 6),
    // selectionLength 5.
    const state = EditorState.create({
      doc: 'hello world',
      selection: { anchor: 0, head: 5 },
    });
    const stats = getCursorPosition(state);
    assert.equal(stats.line, 1);
    assert.equal(stats.col, 6);
    assert.equal(stats.selectionLength, 5);
  });

  it('counts UTF-16 code units (not codepoints)', () => {
    // '😀' is one codepoint but two UTF-16 code units. So doc length is 2.
    // Explicit head=2 puts cursor after the surrogate pair (col 3).
    const state = EditorState.create({
      doc: '😀',
      selection: { anchor: 2 },
    });
    const stats = getCursorPosition(state);
    assert.equal(stats.docLength, 2);
    assert.equal(stats.col, 3);
  });

  it('handles cursor at the very start of the document', () => {
    const state = EditorState.create({ doc: 'abc', selection: { anchor: 0 } });
    const stats = getCursorPosition(state);
    assert.equal(stats.line, 1);
    assert.equal(stats.col, 1);
    assert.equal(stats.selectionLength, 0);
  });
});

describe('clampFontSize', () => {
  it('clamps below MIN_FONT_SIZE', () => {
    assert.equal(clampFontSize(0), MIN_FONT_SIZE);
    assert.equal(clampFontSize(5), MIN_FONT_SIZE);
    assert.equal(clampFontSize(MIN_FONT_SIZE - 1), MIN_FONT_SIZE);
  });

  it('clamps above MAX_FONT_SIZE', () => {
    assert.equal(clampFontSize(100), MAX_FONT_SIZE);
    assert.equal(clampFontSize(MAX_FONT_SIZE + 1), MAX_FONT_SIZE);
  });

  it('passes through values within range', () => {
    assert.equal(clampFontSize(13), 13);
    assert.equal(clampFontSize(DEFAULT_FONT_SIZE), DEFAULT_FONT_SIZE);
  });

  it('rounds fractional inputs', () => {
    assert.equal(clampFontSize(13.4), 13);
    assert.equal(clampFontSize(13.7), 14);
  });

  it('returns DEFAULT_FONT_SIZE for non-finite input', () => {
    assert.equal(clampFontSize(NaN), DEFAULT_FONT_SIZE);
    assert.equal(clampFontSize(Infinity), DEFAULT_FONT_SIZE);
  });
});

describe('stepFontSize', () => {
  it('steps up by FONT_SIZE_STEP', () => {
    assert.equal(stepFontSize(14, 1), 15);
  });

  it('steps down by FONT_SIZE_STEP', () => {
    assert.equal(stepFontSize(14, -1), 13);
  });

  it('clamps to MIN_FONT_SIZE when stepping below', () => {
    assert.equal(stepFontSize(MIN_FONT_SIZE, -1), MIN_FONT_SIZE);
  });

  it('clamps to MAX_FONT_SIZE when stepping above', () => {
    assert.equal(stepFontSize(MAX_FONT_SIZE, 1), MAX_FONT_SIZE);
  });
});

describe('loadFontSize / persistFontSize', () => {
  beforeEach(() => {
    // Each test gets a fresh stub via withStorage; nothing to reset here.
  });

  it('returns DEFAULT_FONT_SIZE when nothing stored', () => {
    withStorage(() => {
      assert.equal(loadFontSize(), DEFAULT_FONT_SIZE);
    });
  });

  it('round-trips persisted value', () => {
    withStorage(() => {
      persistFontSize(18);
      assert.equal(loadFontSize(), 18);
    });
  });

  it('clamps corrupted out-of-range values to DEFAULT', () => {
    withStorage(() => {
      // Bypass persistFontSize's clamp to write garbage directly.
      (globalThis as any).window.localStorage.setItem(
        'whale.text-editor.fontSize',
        '999',
      );
      assert.equal(loadFontSize(), MAX_FONT_SIZE);
    });
  });

  it('falls back to DEFAULT when stored value is non-numeric', () => {
    withStorage(() => {
      (globalThis as any).window.localStorage.setItem(
        'whale.text-editor.fontSize',
        'abc',
      );
      // clampFontSize(NaN) === DEFAULT_FONT_SIZE
      assert.equal(loadFontSize(), DEFAULT_FONT_SIZE);
    });
  });

  it('clamps persisted value when called with out-of-range input', () => {
    withStorage(() => {
      persistFontSize(999);
      assert.equal(loadFontSize(), MAX_FONT_SIZE);
      persistFontSize(-5);
      assert.equal(loadFontSize(), MIN_FONT_SIZE);
    });
  });
});

describe('loadWrapMode / persistWrapMode', () => {
  it('returns "nowrap" when nothing stored', () => {
    withStorage(() => {
      assert.equal(loadWrapMode(), 'nowrap');
    });
  });

  it('round-trips "wrap"', () => {
    withStorage(() => {
      persistWrapMode('wrap');
      assert.equal(loadWrapMode(), 'wrap');
    });
  });

  it('round-trips "nowrap"', () => {
    withStorage(() => {
      persistWrapMode('wrap');
      persistWrapMode('nowrap');
      assert.equal(loadWrapMode(), 'nowrap');
    });
  });

  it('treats unrecognized stored value as "nowrap"', () => {
    withStorage(() => {
      (globalThis as any).window.localStorage.setItem(
        'whale.text-editor.wrap',
        'maybe',
      );
      assert.equal(loadWrapMode(), 'nowrap');
    });
  });
});

describe('supportsFolding', () => {
  it('accepts foldable extensions', () => {
    assert.equal(supportsFolding('/a/b/foo.json'), true);
    assert.equal(supportsFolding('app.ts'), true);
    assert.equal(supportsFolding('foo.js'), true);
    assert.equal(supportsFolding('styles.css'), true);
    assert.equal(supportsFolding('data.xml'), true);
  });

  it('rejects non-foldable extensions', () => {
    assert.equal(supportsFolding('plain.txt'), false);
    assert.equal(supportsFolding('README.md'), false);
    assert.equal(supportsFolding('config.yaml'), false);
    assert.equal(supportsFolding('index.html'), false);
    assert.equal(supportsFolding('page.htm'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(supportsFolding('Foo.JSON'), true);
    assert.equal(supportsFolding('App.TS'), true);
  });

  it('rejects paths without an extension', () => {
    assert.equal(supportsFolding('Makefile'), false);
    assert.equal(supportsFolding('.gitignore'), false);
  });

  it('rejects empty extension (trailing dot)', () => {
    assert.equal(supportsFolding('weird.'), false);
  });
});

describe('exported constants', () => {
  it('exposes sensible defaults', () => {
    assert.equal(STATUS_NO_VALUE, '—');
    assert.equal(DEFAULT_FONT_SIZE, 14);
    assert.equal(MIN_FONT_SIZE, 10);
    assert.equal(MAX_FONT_SIZE, 32);
    assert.equal(FONT_SIZE_STEP, 1);
  });
});

describe('countMatches', () => {
  it('returns 0 for empty query', () => {
    assert.equal(countMatches('', 'hello world'), 0);
  });

  it('returns 0 for empty text', () => {
    assert.equal(countMatches('foo', ''), 0);
  });

  it('returns 0 when no match found', () => {
    assert.equal(countMatches('xyz', 'hello world'), 0);
  });

  it('counts plain string matches (default case-insensitive)', () => {
    assert.equal(countMatches('foo', 'foo bar foo baz foo'), 3);
    assert.equal(countMatches('FOO', 'foo bar foo'), 2); // case-insensitive by default
  });

  it('respects caseSensitive option', () => {
    assert.equal(countMatches('FOO', 'foo bar FOO FOO', { caseSensitive: true }), 2);
    assert.equal(countMatches('FOO', 'foo bar FOO FOO', { caseSensitive: false }), 3);
  });

  it('counts non-overlapping matches', () => {
    // "aaaa" with needle "aa" → 2 matches (positions 0 and 2), not 3.
    assert.equal(countMatches('aa', 'aaaa'), 2);
  });

  it('handles needle of length 1', () => {
    assert.equal(countMatches('a', 'banana'), 3);
  });

  it('decodes \\n / \\r / \\t in plain queries (SearchQuery.unquote parity)', () => {
    const text = 'a\nb\nc';
    assert.equal(countMatches('\\n', text), 2); // 2 newlines
    assert.equal(countMatches('a\\nb', text), 1); // literal "a\nb"
  });

  it('respects wholeWord option in plain mode', () => {
    const text = 'cat cats category dog';
    assert.equal(countMatches('cat', text, { wholeWord: true }), 1);
    assert.equal(countMatches('cat', text, { wholeWord: false }), 3);
  });

  it('escapes regex metacharacters in plain wholeWord', () => {
    // The needle contains a `.`; wholeWord must still match the literal dot.
    const text = 'foo a.b bar a.b baz';
    assert.equal(countMatches('a.b', text, { wholeWord: true }), 2);
  });

  it('counts regex matches', () => {
    assert.equal(countMatches('\\d+', 'abc 123 def 45 gh', { regex: true }), 2);
  });

  it('respects caseSensitive option in regex mode', () => {
    assert.equal(countMatches('FOO', 'foo FOO FOO', { regex: true, caseSensitive: true }), 2);
    assert.equal(countMatches('FOO', 'foo FOO FOO', { regex: true, caseSensitive: false }), 3);
  });

  it('respects multiline option in regex mode', () => {
    const text = 'foo\nbar\nfoo';
    assert.equal(countMatches('^foo', text, { regex: true, multiline: true }), 2);
    assert.equal(countMatches('^foo', text, { regex: true, multiline: false }), 1);
  });

  it('returns 0 for invalid regex (no throw)', () => {
    assert.equal(countMatches('[unclosed', 'hello', { regex: true }), 0);
  });

  it('handles zero-width regex matches without infinite loop', () => {
    // `^` matches at start of string (zero-width). Should count once and exit.
    assert.equal(countMatches('^', 'hello', { regex: true }), 1);
    // `(?=o)` is a lookahead matching empty string before every "o".
    // Should count occurrences of "o" and exit gracefully.
    assert.equal(countMatches('(?=o)', 'hello world', { regex: true }), 2);
  });

  it('handles Unicode in plain mode', () => {
    assert.equal(countMatches('你', '你好你好世界'), 2);
    // Case-insensitive: the search extension normalizes via NFKD, but for
    // status-bar use we keep it simple — Latin case-insensitive only.
    assert.equal(countMatches('WORLD', 'hello World', { caseSensitive: false }), 1);
  });

  it('handles empty text with various options', () => {
    assert.equal(countMatches('foo', '', { regex: true }), 0);
    assert.equal(countMatches('foo', '', { wholeWord: true }), 0);
    assert.equal(countMatches('.*', '', { regex: true }), 0);
  });
});