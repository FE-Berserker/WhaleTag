/**
 * Pure display/zoom math for the office-viewer (§16.8) — DOM-free so the
 * fit-mode and navigation rules are unit-testable without an iframe.
 *
 * Mirrors pdf-viewer's semantics exactly (same formulas, same clamping):
 *  - `manual` mode: pages render at `manualZoom` CSS scale.
 *  - `fit-width`: scale so the page width fills the scroll container's
 *    content box (32px of vertical padding excluded).
 *  - `fit-page`: scale so the WHOLE page (width AND height) fits.
 */

export type ZoomMode = 'manual' | 'fit-width' | 'fit-page';

export const ZOOM_STEP = 0.25;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Clamp a manual-zoom target into the supported range. */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Clamp a 1-based page number into `1..pageCount` (1 when no doc). */
export function clampPage(page: number, pageCount: number): number {
  return Math.max(1, Math.min(pageCount || 1, page));
}

/**
 * CSS display scale for a page of `baseW × baseH` (the scale=1 viewport
 * dimensions, rotation already applied) under the given zoom mode. The
 * container's inner content box excludes 32px of padding (16px top + 16px
 * bottom on #pages). Degenerate inputs (zero-size container/page) fall back
 * to 1 rather than producing 0 / Infinity / NaN.
 */
export function computeDisplayScale(
  mode: ZoomMode,
  manualZoom: number,
  containerW: number,
  containerH: number,
  baseW: number,
  baseH: number
): number {
  if (mode === 'manual') return manualZoom;
  if (baseW <= 0 || baseH <= 0) return 1;
  const w = Math.max(0, containerW - 32);
  const h = Math.max(0, containerH - 32);
  if (mode === 'fit-width') {
    return w > 0 ? w / baseW : 1;
  }
  // fit-page
  if (w <= 0 || h <= 0) return 1;
  return Math.min(w / baseW, h / baseH);
}

/** Next rotation for a page: `current + delta` normalized into [0, 360). */
export function nextRotation(current: number, delta: 90 | -90): number {
  return (((current + delta) % 360) + 360) % 360;
}

/** Human-readable byte size for the status bar (`—` when unknown). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
