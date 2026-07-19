import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampZoom,
  clampPage,
  computeDisplayScale,
  nextRotation,
  formatBytes,
  ZOOM_MIN,
  ZOOM_MAX,
} from './view-math';

describe('view-math: clampZoom', () => {
  it('clamps into [ZOOM_MIN, ZOOM_MAX]', () => {
    assert.equal(clampZoom(1), 1);
    assert.equal(clampZoom(0), ZOOM_MIN);
    assert.equal(clampZoom(100), ZOOM_MAX);
    assert.equal(clampZoom(-3), ZOOM_MIN);
  });
});

describe('view-math: clampPage', () => {
  it('clamps into 1..pageCount, with 1 as the no-doc floor', () => {
    assert.equal(clampPage(3, 10), 3);
    assert.equal(clampPage(0, 10), 1);
    assert.equal(clampPage(99, 10), 10);
    assert.equal(clampPage(5, 0), 1); // no doc → 1
    assert.equal(clampPage(-2, 4), 1);
  });
});

describe('view-math: computeDisplayScale', () => {
  it('manual mode returns the manual zoom regardless of geometry', () => {
    assert.equal(computeDisplayScale('manual', 1.5, 800, 600, 400, 300), 1.5);
    assert.equal(computeDisplayScale('manual', 0.5, 0, 0, 0, 0), 0.5);
  });

  it('fit-width scales the page width to the padded container width', () => {
    // container 832 → padded 800; base 400 → 2x
    assert.equal(computeDisplayScale('fit-width', 1, 832, 600, 400, 300), 2);
  });

  it('fit-page takes the tighter of the width/height ratios', () => {
    // padded 800×600; base 400×400 → w 2, h 1.5 → 1.5
    assert.equal(computeDisplayScale('fit-page', 1, 832, 632, 400, 400), 1.5);
    // base 400×600 → w 2, h 1 → 1
    assert.equal(computeDisplayScale('fit-page', 1, 832, 632, 400, 600), 1);
  });

  it('degenerate geometry falls back to 1 (never 0/NaN/Infinity)', () => {
    assert.equal(computeDisplayScale('fit-width', 1, 0, 0, 400, 300), 1);
    assert.equal(computeDisplayScale('fit-page', 1, 0, 600, 400, 300), 1);
    assert.equal(computeDisplayScale('fit-width', 1, 832, 600, 0, 300), 1);
    assert.equal(computeDisplayScale('fit-page', 1, 832, 632, 400, 0), 1);
  });
});

describe('view-math: nextRotation', () => {
  it('rotates ±90 and wraps into [0, 360)', () => {
    assert.equal(nextRotation(0, 90), 90);
    assert.equal(nextRotation(270, 90), 0);
    assert.equal(nextRotation(0, -90), 270);
    assert.equal(nextRotation(90, -90), 0);
    assert.equal(nextRotation(180, 90), 270);
  });
});

describe('view-math: formatBytes', () => {
  it('formats B / KB / MB / GB and the unknown case', () => {
    assert.equal(formatBytes(null), '—');
    assert.equal(formatBytes(undefined), '—');
    assert.equal(formatBytes(NaN), '—');
    assert.equal(formatBytes(-5), '—');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GB');
  });
});
