/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * html-viewer — unit tests for html-stats.ts pure helpers.
 *
 * Run via `npm test` (electron --test under node:test). Mirror of the test
 * pattern used by json-viewer/json-model.test.ts:
 * - `node:test` + `node:assert/strict`
 * - no DOM (helpers are DOM-free by design)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  countTags,
  extractLines,
  clampZoom,
  computeFitWidthZoom,
  ZOOM_STEP,
  ZOOM_MIN,
  ZOOM_MAX,
} from './html-stats';

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

describe('countTags', () => {
  it('counts a single opening tag', () => {
    assert.equal(countTags('<p>hello</p>'), 1);
  });

  it('counts multiple nested opening tags', () => {
    assert.equal(countTags('<div><span>x</span></div>'), 2);
  });

  it('counts self-closing tags', () => {
    assert.equal(countTags('<a href="x">link</a><br/>'), 2);
  });

  it('does NOT count comments', () => {
    assert.equal(countTags('<!-- <p> not a tag -->'), 0);
    assert.equal(countTags('before<!-- <div> --><span>x</span>'), 1);
  });

  it('does NOT count the doctype declaration', () => {
    assert.equal(
      countTags('<!DOCTYPE html><html><body><h1>x</h1></body></html>'),
      3,
    );
  });

  it('does NOT count closing tags', () => {
    assert.equal(countTags('</p></div></span>'), 0);
  });

  it('returns 0 for empty input', () => {
    assert.equal(countTags(''), 0);
  });

  it('returns 0 for raw text without tags', () => {
    assert.equal(countTags('plain text without markup'), 0);
  });

  it('counts tags with digits in their names (HTML5)', () => {
    assert.equal(countTags('<h1>x</h1><h2>y</h2>'), 2);
  });

  it('counts uppercase tag names', () => {
    assert.equal(countTags('<DIV><P>x</P></DIV>'), 2);
  });
});

describe('extractLines', () => {
  it('returns [] for empty string (NOT [""])', () => {
    assert.deepEqual(extractLines(''), []);
  });

  it('returns single-element array for single-line content', () => {
    assert.deepEqual(extractLines('no newline'), ['no newline']);
  });

  it('splits on \\n', () => {
    assert.deepEqual(extractLines('a\nb\nc'), ['a', 'b', 'c']);
  });

  it('handles consecutive newlines producing empty strings', () => {
    assert.deepEqual(extractLines('\n\n'), ['', '', '']);
  });

  it('handles trailing newline producing trailing empty string', () => {
    assert.deepEqual(extractLines('a\nb\n'), ['a', 'b', '']);
  });
});

describe('clampZoom', () => {
  it('clamps below default minimum', () => {
    assert.equal(clampZoom(0.1), ZOOM_MIN);
  });

  it('clamps above default maximum', () => {
    assert.equal(clampZoom(5), ZOOM_MAX);
  });

  it('passes through values within range', () => {
    assert.equal(clampZoom(1.5), 1.5);
    assert.equal(clampZoom(1), 1);
  });

  it('honors custom min/max bounds', () => {
    assert.equal(clampZoom(0.5, 0.5, 2), 0.5);
    assert.equal(clampZoom(10, 0.5, 2), 2);
  });

  it('returns 1 for non-finite input', () => {
    assert.equal(clampZoom(NaN), 1);
    assert.equal(clampZoom(Infinity), 1);
  });

  it('exports sensible defaults (ZOOM_STEP / MIN / MAX)', () => {
    assert.equal(ZOOM_STEP, 0.25);
    assert.equal(ZOOM_MIN, 0.25);
    assert.equal(ZOOM_MAX, 4);
  });
});

describe('computeFitWidthZoom', () => {
  it('returns 1 when content exactly fits', () => {
    assert.equal(computeFitWidthZoom(800, 800), 1);
  });

  it('scales DOWN when content is wider than container', () => {
    assert.equal(computeFitWidthZoom(800, 1600), 0.5);
    assert.equal(computeFitWidthZoom(400, 1000), 0.4);
  });

  it('clamps to 1 when content is narrower (no upscale)', () => {
    assert.equal(computeFitWidthZoom(1600, 800), 1);
    assert.equal(computeFitWidthZoom(1000, 500), 1);
  });

  it('returns 1 when container width is 0', () => {
    assert.equal(computeFitWidthZoom(0, 800), 1);
  });

  it('returns 1 when base content width is 0', () => {
    assert.equal(computeFitWidthZoom(800, 0), 1);
  });

  it('returns 1 for non-finite inputs', () => {
    assert.equal(computeFitWidthZoom(NaN, 800), 1);
    assert.equal(computeFitWidthZoom(800, NaN), 1);
    assert.equal(computeFitWidthZoom(Infinity, Infinity), 1);
  });
});