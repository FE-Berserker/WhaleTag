/**
 * font-viewer — pure helpers (DOM-free, runs under node:test).
 *
 * Mirrors the split used by html-viewer/html-stats.ts,
 * json-viewer/json-model.ts. No `window`, no `document` — only `Math` and
 * `Number`.
 *
 * Scope: numeric clamping + formatting helpers used by the slider/toolbar
 * state machine. Opentype-name-table parsing lives in `./font-info.ts`.
 */

// --- Bytes ---------------------------------------------------------------

/** Convert a byte count to a short human string (`1024` → `"1.0 KB"`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- Font sizing (in CSS px) --------------------------------------------

export const SIZE_MIN = 14;
export const SIZE_MAX = 96;
export const SIZE_DEFAULT = 40;
export const SIZE_STEP = 1;

/** Clamp a font-size value to [SIZE_MIN, SIZE_MAX]. Non-finite → DEFAULT. */
export function clampSize(px: number): number {
  if (!Number.isFinite(px)) return SIZE_DEFAULT;
  return clamp(px, SIZE_MIN, SIZE_MAX);
}

// --- Tracking (letter-spacing, in px, can be negative) ------------------

export const TRACKING_MIN = -5;
export const TRACKING_MAX = 20;
export const TRACKING_DEFAULT = 0;
export const TRACKING_STEP = 0.5;

/** Clamp a letter-spacing value (px). Non-finite → DEFAULT. */
export function clampTracking(px: number): number {
  if (!Number.isFinite(px)) return TRACKING_DEFAULT;
  return clamp(px, TRACKING_MIN, TRACKING_MAX);
}

// --- Leading (line-height, unitless multiplier) -------------------------

export const LEADING_MIN = 0.8;
export const LEADING_MAX = 2.5;
export const LEADING_DEFAULT = 1.35;
export const LEADING_STEP = 0.05;

/** Clamp a line-height multiplier. Non-finite → DEFAULT. */
export function clampLeading(n: number): number {
  if (!Number.isFinite(n)) return LEADING_DEFAULT;
  return clamp(n, LEADING_MIN, LEADING_MAX);
}

// --- Weight axis (CSS font-weight / `wght` variation axis) --------------

export const WEIGHT_MIN = 100;
export const WEIGHT_MAX = 900;
export const WEIGHT_DEFAULT = 400;
export const WEIGHT_STEP = 10;

/** Clamp a font-weight axis value (100..900). Rounded to nearest 10. */
export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return WEIGHT_DEFAULT;
  const rounded = Math.round(w / WEIGHT_STEP) * WEIGHT_STEP;
  return clamp(rounded, WEIGHT_MIN, WEIGHT_MAX);
}

// --- Slant axis (`slnt` variation axis, degrees; positive = forward) ---

export const SLANT_MIN = -15;
export const SLANT_MAX = 0;
export const SLANT_DEFAULT = 0;
export const SLANT_STEP = 0.5;

/** Clamp a slant axis value in degrees. Non-finite → DEFAULT. */
export function clampSlant(s: number): number {
  if (!Number.isFinite(s)) return SLANT_DEFAULT;
  return clamp(s, SLANT_MIN, SLANT_MAX);
}

// --- Width axis (`wdth` variation axis, percent 50..200) ---------------

export const WIDTH_MIN = 50;
export const WIDTH_MAX = 200;
export const WIDTH_DEFAULT = 100;
export const WIDTH_STEP = 1;

/** Clamp a width-axis percentage value. Non-finite → DEFAULT. */
export function clampWidth(p: number): number {
  if (!Number.isFinite(p)) return WIDTH_DEFAULT;
  return clamp(p, WIDTH_MIN, WIDTH_MAX);
}

// --- Internal ----------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
