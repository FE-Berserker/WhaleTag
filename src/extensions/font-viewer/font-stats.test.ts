/**
 * font-viewer — unit tests for font-stats.ts pure helpers.
 *
 * Run under `node:test` via the existing `npm test` script (electron --test).
 * Mirrors the test pattern of html-viewer/html-stats.test.ts:
 * - `node:test` + `node:assert/strict`
 * - no DOM (helpers are DOM-free by design)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  clampSize,
  clampTracking,
  clampLeading,
  clampWeight,
  clampSlant,
  clampWidth,
  SIZE_MIN,
  SIZE_MAX,
  SIZE_DEFAULT,
  TRACKING_MIN,
  TRACKING_MAX,
  TRACKING_DEFAULT,
  LEADING_MIN,
  LEADING_MAX,
  LEADING_DEFAULT,
  WEIGHT_MIN,
  WEIGHT_MAX,
  WEIGHT_DEFAULT,
  SLANT_MIN,
  SLANT_MAX,
  SLANT_DEFAULT,
  WIDTH_MIN,
  WIDTH_MAX,
  WIDTH_DEFAULT,
} from './font-stats';

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
  });

  it('formats MB with one decimal', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 5), '5.0 MB');
  });

  it('formats GB with two decimals', () => {
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
  });

  it('handles non-finite / negative inputs gracefully', () => {
    assert.equal(formatBytes(NaN), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Infinity), '0 B');
  });
});

describe('clampSize', () => {
  it('clamps below minimum', () => {
    assert.equal(clampSize(5), SIZE_MIN);
  });

  it('clamps above maximum', () => {
    assert.equal(clampSize(200), SIZE_MAX);
  });

  it('passes through values within range', () => {
    assert.equal(clampSize(40), 40);
    assert.equal(clampSize(72), 72);
  });

  it('returns DEFAULT for non-finite input', () => {
    assert.equal(clampSize(NaN), SIZE_DEFAULT);
    assert.equal(clampSize(Infinity), SIZE_DEFAULT);
  });

  it('exposes sensible defaults', () => {
    assert.equal(SIZE_MIN, 14);
    assert.equal(SIZE_MAX, 96);
    assert.equal(SIZE_DEFAULT, 40);
  });
});

describe('clampTracking', () => {
  it('clamps below minimum (negative)', () => {
    assert.equal(clampTracking(-10), TRACKING_MIN);
  });

  it('clamps above maximum', () => {
    assert.equal(clampTracking(50), TRACKING_MAX);
  });

  it('passes through values within range', () => {
    assert.equal(clampTracking(0), 0);
    assert.equal(clampTracking(2.5), 2.5);
  });

  it('returns DEFAULT for non-finite input', () => {
    assert.equal(clampTracking(NaN), TRACKING_DEFAULT);
  });

  it('exposes sensible defaults', () => {
    assert.equal(TRACKING_MIN, -5);
    assert.equal(TRACKING_MAX, 20);
    assert.equal(TRACKING_DEFAULT, 0);
  });
});

describe('clampLeading', () => {
  it('clamps below minimum', () => {
    assert.equal(clampLeading(0.5), LEADING_MIN);
  });

  it('clamps above maximum', () => {
    assert.equal(clampLeading(5), LEADING_MAX);
  });

  it('passes through values within range', () => {
    assert.equal(clampLeading(1.5), 1.5);
    assert.equal(clampLeading(2), 2);
  });

  it('returns DEFAULT for non-finite input', () => {
    assert.equal(clampLeading(NaN), LEADING_DEFAULT);
  });

  it('exposes sensible defaults', () => {
    assert.equal(LEADING_MIN, 0.8);
    assert.equal(LEADING_MAX, 2.5);
    assert.equal(LEADING_DEFAULT, 1.35);
  });
});

describe('clampWeight', () => {
  it('clamps below 100', () => {
    assert.equal(clampWeight(50), WEIGHT_MIN);
  });

  it('clamps above 900', () => {
    assert.equal(clampWeight(1200), WEIGHT_MAX);
  });

  it('rounds to nearest 10', () => {
    assert.equal(clampWeight(407), 410);
    assert.equal(clampWeight(404), 400);
    assert.equal(clampWeight(750), 750);
  });

  it('passes through aligned values within range', () => {
    assert.equal(clampWeight(400), 400);
    assert.equal(clampWeight(700), 700);
  });

  it('returns DEFAULT for non-finite input', () => {
    assert.equal(clampWeight(NaN), WEIGHT_DEFAULT);
  });

  it('exposes sensible defaults', () => {
    assert.equal(WEIGHT_MIN, 100);
    assert.equal(WEIGHT_MAX, 900);
    assert.equal(WEIGHT_DEFAULT, 400);
  });
});

describe('clampSlant', () => {
  it('clamps below minimum (most negative backward slant)', () => {
    assert.equal(clampSlant(-30), SLANT_MIN);
  });

  it('clamps above maximum (never positive forward slant)', () => {
    assert.equal(clampSlant(10), SLANT_MAX);
  });

  it('passes through values within range', () => {
    assert.equal(clampSlant(0), 0);
    assert.equal(clampSlant(-10), -10);
    assert.equal(clampSlant(-7.5), -7.5);
  });

  it('returns DEFAULT for non-finite input', () => {
    assert.equal(clampSlant(NaN), SLANT_DEFAULT);
  });

  it('exposes sensible defaults', () => {
    assert.equal(SLANT_MIN, -15);
    assert.equal(SLANT_MAX, 0);
    assert.equal(SLANT_DEFAULT, 0);
  });
});

describe('clampWidth', () => {
  it('clamps below 50%', () => {
    assert.equal(clampWidth(25), WIDTH_MIN);
  });

  it('clamps above 200%', () => {
    assert.equal(clampWidth(300), WIDTH_MAX);
  });

  it('passes through values within range', () => {
    assert.equal(clampWidth(75), 75);
    assert.equal(clampWidth(150), 150);
  });

  it('returns DEFAULT for non-finite input', () => {
    assert.equal(clampWidth(NaN), WIDTH_DEFAULT);
  });

  it('exposes sensible defaults', () => {
    assert.equal(WIDTH_MIN, 50);
    assert.equal(WIDTH_MAX, 200);
    assert.equal(WIDTH_DEFAULT, 100);
  });
});
