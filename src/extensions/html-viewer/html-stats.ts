/**
 * html-viewer — pure helpers
 *
 * Extracted from `index.ts` so they can be tested in isolation without booting
 * an iframe. Mirrors the split used by json-viewer (json-model),
 * image-viewer (keymap), and ebook-viewer (plain-text, search-index,
 * annotations-client).
 *
 * No DOM, no `window`, no `document` — `node:test` runs these in a plain
 * Node process.
 */

/** Convert a byte count to a short human string (1024 → "1.0 KB"). */
export function formatBytes(bytes: number): string {
 if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
 if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
 return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Count opening HTML tags in a raw HTML string. Used as a "complexity"
 * indicator in the status bar — a proxy for how much markup the file
 * contains.
 *
 * Matches opening tags (`<tag` / `<tag ` / `<tag>`) but NOT closing tags
 * (`</tag>`), comments (`<!--`), processing instructions (`<?`), nor the
 * doctype declaration (`<!DOCTYPE`). Comments are stripped first because
 * the regex would otherwise match tags mentioned inside comment bodies.
 */
export function countTags(raw: string): number {
 if (!raw) return 0;
 // Strip HTML comments first so tags mentioned inside `<!-- <p> -->` are
 // not counted. Multiline-aware (`[\s\S]*?`).
 const stripped = raw.replace(/<!--[\s\S]*?-->/g, '');
 // `<` followed by an ASCII letter then zero or more ASCII letters/digits.
 // Stops before whitespace, `>`, `/`, `!`, `?` (closing tag, comment, PI).
 const matches = stripped.match(/<[A-Za-z][A-Za-z0-9]*/g);
 return matches ? matches.length : 0;
}

/**
 * Split raw content into lines. Returns `[]` (NOT `['']`) when input is
 * empty — matches 's empty-file guard so the status bar shows 0
 * not 1 for an empty file.
 */
export function extractLines(raw: string): string[] {
 if (raw === '') return [];
 return raw.split('\n');
}

export const ZOOM_STEP = 0.25;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Clamp a zoom value to [min, max]. Defaults to [ZOOM_MIN, ZOOM_MAX]. */
export function clampZoom(z: number, min: number = ZOOM_MIN, max: number = ZOOM_MAX): number {
 if (!Number.isFinite(z)) return 1;
 if (z < min) return min;
 if (z > max) return max;
 return z;
}

/**
 * Compute the zoom factor needed to fit `baseContentWidth` into
 * `containerWidth`. Result is clamped to `<= 1` so that narrow content
 * doesn't get upscaled (which would look fuzzy). Zero/negative inputs
 * short-circuit to 1.
 *
 * Used for the "fit-width" zoom mode where the html-viewer's
 * `ResizeObserver` triggers a re-measure whenever the container size
 * changes.
 */
export function computeFitWidthZoom(
 containerWidth: number,
 baseContentWidth: number,
): number {
 if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
 if (!Number.isFinite(baseContentWidth) || baseContentWidth <= 0) return 1;
 const ratio = containerWidth / baseContentWidth;
 // Only scale DOWN; never upscale beyond 100% which would look fuzzy and
 // isn't what "fit-width" means (fit-width is a "make it fit", not "zoom in").
 return ratio < 1 ? ratio : 1;
}