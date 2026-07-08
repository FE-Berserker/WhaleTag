/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * zoom / shared — unit tests for the pure-math helpers.
 *
 * Mirrors the style of `image-viewer/keymap.test.ts` and
 * `html-viewer/html-stats.test.ts`: `node:test` + `node:assert/strict`,
 * DOM-free. The controller factory (`createViewportController`) is
 * integration-tested separately if needed (see the dedicated `*.test.ts`
 * pattern for DOM-required tests in `image-viewer/` — currently no DOM
 * tests exist; the controller is verified via image-viewer's manual smoke).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFitZoom,
  clampPan,
  zoomAtPoint,
  buildTransform,
  MIN_ZOOM_FACTOR_OF_FIT,
  MAX_ZOOM,
  WHEEL_FACTOR,
  STEP_FACTOR,
  DEFAULT_PAN_MARGIN,
  type Rotation,
} from './zoom';

// ── computeFitZoom ─────────────────────────────────────────────────────

describe('computeFitZoom', () => {
  it('returns 1 when content exactly fills viewport', () => {
    assert.equal(computeFitZoom({ w: 800, h: 600 }, { w: 800, h: 600 }), 1);
  });

  it('scales DOWN to the smaller of the two axis ratios', () => {
    // 16:9 image, 4:3 viewport → height-bound
    const f = computeFitZoom({ w: 1600, h: 900 }, { w: 800, h: 600 });
    // height-bound: 600 / 900 = 0.667; width-bound: 800/1600 = 0.5; take min
    assert.equal(f, 0.5);
  });

  it('clamps to 1 (no upscale) when image is smaller than viewport', () => {
    assert.equal(computeFitZoom({ w: 100, h: 100 }, { w: 800, h: 600 }), 1);
  });

  it('accounts for 90° rotation (bounding box swaps in non-square viewport)', () => {
    // Image 2000x1000 in viewport 800x600:
    //   0°:  effW=2000, effH=1000 → min(800/2000, 600/1000) = min(0.4, 0.6) = 0.4
    //   90°: effW=1000, effH=2000 → min(800/1000, 600/2000) = min(0.8, 0.3) = 0.3
    const rot0 = computeFitZoom({ w: 2000, h: 1000 }, { w: 800, h: 600 }, 0);
    const rot90 = computeFitZoom({ w: 2000, h: 1000 }, { w: 800, h: 600 }, 90 as Rotation);
    assert.equal(rot0, 0.4);
    assert.equal(rot90, 0.3);
  });

  it('180° rotation gives the same factor as 0°', () => {
    const a = computeFitZoom({ w: 100, h: 200 }, { w: 800, h: 800 }, 0);
    const b = computeFitZoom({ w: 100, h: 200 }, { w: 800, h: 800 }, 180 as Rotation);
    assert.equal(a, b);
  });

  it('returns 1 for non-finite / zero inputs', () => {
    assert.equal(computeFitZoom({ w: 0, h: 100 }, { w: 800, h: 600 }), 1);
    assert.equal(computeFitZoom({ w: NaN, h: 100 }, { w: 800, h: 600 }), 1);
    assert.equal(computeFitZoom({ w: 100, h: 100 }, { w: 0, h: 600 }), 1);
    assert.equal(computeFitZoom({ w: 100, h: 100 }, { w: Infinity, h: 600 }), 1);
  });
});

// ── clampPan ───────────────────────────────────────────────────────────

describe('clampPan', () => {
  it('returns 0 when image fits inside viewport on a given axis', () => {
    // 100x100 image, zoom=1 → 100px display < 800px viewport → no panning.
    const r = clampPan({ x: 999, y: 999 }, { w: 100, h: 100 }, 1, { w: 800, h: 800 });
    assert.equal(r.x, 0);
    assert.equal(r.y, 0);
  });

  it('clamps both axes independently when zoomed past fit', () => {
    // 400x400 image at zoom=4 = 1600px display in 800px viewport.
    // (1600 - 800) / 2 + 24 = 400 + 24 = 424. So pan is in [-424, +424].
    const r = clampPan({ x: 9999, y: -9999 }, { w: 400, h: 400 }, 4, { w: 800, h: 800 });
    assert.equal(r.x, 424);
    assert.equal(r.y, -424);
  });

  it('respects custom margin', () => {
    const r = clampPan({ x: 9999, y: 0 }, { w: 400, h: 400 }, 4, { w: 800, h: 800 }, 0, 100);
    // (1600 - 800) / 2 + 100 = 400 + 100 = 500.
    assert.equal(r.x, 500);
  });

  it('accounts for rotation on bounding box', () => {
    // 100x200 image at 0° rotation: zoomed to fill width-bound.
    // At 90° rotation, effective dims become 200x100.
    const r0 = clampPan({ x: 0, y: 9999 }, { w: 100, h: 200 }, 1, { w: 100, h: 1000 }, 0);
    const r90 = clampPan({ x: 0, y: 9999 }, { w: 100, h: 200 }, 1, { w: 100, h: 1000 }, 90 as Rotation);
    // For r0: zoomed Y = 200 > viewport Y = 1000? No → returns 0 on Y.
    // Actually wait — 200 < 1000 so it returns 0.
    assert.equal(r0.y, 0);
    // For r90: rotated dims = 200 (W) x 100 (H). Zoomed Y = 100 < 1000 → 0.
    assert.equal(r90.y, 0);
  });

  it('treats non-finite pan as 0', () => {
    const r = clampPan({ x: NaN, y: 0 }, { w: 100, h: 100 }, 4, { w: 800, h: 800 });
    assert.equal(r.x, 0);
  });
});

// ── zoomAtPoint ────────────────────────────────────────────────────────

describe('zoomAtPoint', () => {
  it('factor=1 returns identical state (no change)', () => {
    const r = zoomAtPoint(
      1,
      { x: 400, y: 300 },
      { pan: { x: 0, y: 0 }, zoom: 1 },
      { w: 800, h: 600 },
      { w: 800, h: 600 },
    );
    assert.equal(r.zoom, 1);
    assert.equal(r.pan.x, 0);
    assert.equal(r.pan.y, 0);
  });

  it('zooming in by 2x at center keeps cursor pinned', () => {
    // Cursor at center (400, 300); image at center (400, 300); zoom 1 → 2.
    // The image point under the cursor is the center, which stays under
    // the cursor after zoom (center doesn't move).
    const r = zoomAtPoint(
      2,
      { x: 400, y: 300 },
      { pan: { x: 0, y: 0 }, zoom: 1 },
      { w: 800, h: 600 },
      { w: 800, h: 600 },
    );
    assert.equal(r.zoom, 2);
    assert.equal(r.pan.x, 0);
    assert.equal(r.pan.y, 0);
  });

  it('zooming in around an off-center cursor pulls the image toward the cursor', () => {
    // Cursor at (100, 100) — top-left quadrant.
    // Image currently centered at (400, 300) (viewport center).
    // After zoom 2x around (100, 100), the image should translate to keep
    // the point under the cursor pinned.
    const r = zoomAtPoint(
      2,
      { x: 100, y: 100 },
      { pan: { x: 0, y: 0 }, zoom: 1 },
      { w: 800, h: 600 },
      { w: 800, h: 600 },
    );
    assert.equal(r.zoom, 2);
    // panX' = (100 - 400 - 0) * (2 - 1) + 0 * 2 = -300
    assert.equal(r.pan.x, -300);
    // panY' = (100 - 300 - 0) * (2 - 1) + 0 * 2 = -200
    assert.equal(r.pan.y, -200);
  });

  it('clamps to opts.max', () => {
    const r = zoomAtPoint(
      100, // huge factor
      { x: 400, y: 300 },
      { pan: { x: 0, y: 0 }, zoom: 1 },
      { w: 800, h: 600 },
      { w: 800, h: 600 },
      0,
      { max: 4 },
    );
    assert.equal(r.zoom, 4);
  });

  it('clamps to opts.min', () => {
    const r = zoomAtPoint(
      0.0001, // tiny factor
      { x: 400, y: 300 },
      { pan: { x: 0, y: 0 }, zoom: 1 },
      { w: 800, h: 600 },
      { w: 800, h: 600 },
      0,
      { min: 0.1 },
    );
    assert.equal(r.zoom, 0.1);
  });

  it('non-finite / zero factor returns identical state', () => {
    const r = zoomAtPoint(
      NaN,
      { x: 400, y: 300 },
      { pan: { x: 5, y: 5 }, zoom: 1.5 },
      { w: 800, h: 600 },
      { w: 800, h: 600 },
    );
    assert.equal(r.zoom, 1.5);
    assert.equal(r.pan.x, 5);
    assert.equal(r.pan.y, 5);
  });
});

// ── buildTransform ─────────────────────────────────────────────────────

describe('buildTransform', () => {
  it('identity (zoom=1, no pan/rot/flip) emits translate scale rotate scale', () => {
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 0, false, false),
      'translate(0px, 0px) scale(1) rotate(0deg) scale(1, 1)',
    );
  });

  it('includes pan offsets in translate', () => {
    assert.equal(
      buildTransform({ x: 50, y: -30 }, 1.5, 0, false, false),
      'translate(50px, -30px) scale(1.5) rotate(0deg) scale(1, 1)',
    );
  });

  it('emits the correct rotation in degrees', () => {
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 90, false, false),
      'translate(0px, 0px) scale(1) rotate(90deg) scale(1, 1)',
    );
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 180, false, false),
      'translate(0px, 0px) scale(1) rotate(180deg) scale(1, 1)',
    );
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 270, false, false),
      'translate(0px, 0px) scale(1) rotate(270deg) scale(1, 1)',
    );
  });

  it('flipH emits scale(-1, 1); flipV emits scale(1, -1)', () => {
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 0, true, false),
      'translate(0px, 0px) scale(1) rotate(0deg) scale(-1, 1)',
    );
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 0, false, true),
      'translate(0px, 0px) scale(1) rotate(0deg) scale(1, -1)',
    );
    assert.equal(
      buildTransform({ x: 0, y: 0 }, 1, 0, true, true),
      'translate(0px, 0px) scale(1) rotate(0deg) scale(-1, -1)',
    );
  });
});

// ── Constants ──────────────────────────────────────────────────────────

describe('zoom constants', () => {
  it('MIN_ZOOM_FACTOR_OF_FIT is 0.25 (allow shrink to 1/4 of fit)', () => {
    assert.equal(MIN_ZOOM_FACTOR_OF_FIT, 0.25);
  });
  it('MAX_ZOOM is 16', () => {
    assert.equal(MAX_ZOOM, 16);
  });
  it('WHEEL_FACTOR default is 1.1', () => {
    assert.equal(WHEEL_FACTOR, 1.1);
  });
  it('STEP_FACTOR default is 1.25', () => {
    assert.equal(STEP_FACTOR, 1.25);
  });
  it('DEFAULT_PAN_MARGIN is 24', () => {
    assert.equal(DEFAULT_PAN_MARGIN, 24);
  });
});