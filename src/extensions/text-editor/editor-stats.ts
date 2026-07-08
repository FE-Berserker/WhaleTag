/**
 * text-editor — pure helpers
 *
 * Extracted from `index.ts` so they can be tested in isolation without booting
 * an iframe / CodeMirror view. Mirrors the split used by html-viewer
 * (html-stats), json-viewer (json-model), image-viewer (keymap), and
 * ebook-viewer (plain-text / search-index / annotations-client).
 *
 * No DOM, no `window`, no `document` — `node:test` runs these in a plain
 * Node process. The localStorage helpers are defensive (try/catch on every
 * read/write) so they're safe even in privacy-mode / sandboxed iframes where
 * `window.localStorage` may throw.
 */

import type { EditorState } from '@codemirror/state';

// --- Constants ------------------------------------------------------------

/** Fallback value for any missing status-bar field (mirrors html-viewer / ). */
export const STATUS_NO_VALUE = '—';

/** Default font size in pixels when the user hasn't customized it. */
export const DEFAULT_FONT_SIZE = 14;

/** Minimum font size in pixels — below 10 the editor becomes illegible. */
export const MIN_FONT_SIZE = 10;

/** Maximum font size in pixels — above 32 lines overflow. */
export const MAX_FONT_SIZE = 32;

/** Step size used by zoom in / zoom out. */
export const FONT_SIZE_STEP = 1;

/** Soft-wrap toggle state. */
export type WrapMode = 'wrap' | 'nowrap';

/** Extension categories that support code-folding via `foldGutter`. Plain
 * text / YAML / MD / HTML don't expose enough syntax information for
 * folding to be useful — keep the gutter out so the user doesn't see
 * empty triangles. */
export const FOLDABLE_EXTENSIONS: ReadonlySet<string> = new Set([
 'json',
 'js',
 'ts',
 'mjs',
 'cjs',
 'css',
 'xml',
]);

/** File extensions the editor knows how to syntax-highlight. Mirrors the
 * switch in `index.ts langExtension()`. */
export const KNOWN_LANG_EXTENSIONS: ReadonlySet<string> = new Set([
 'md',
 'json',
 'js',
 'ts',
 'mjs',
 'cjs',
 'css',
 'html',
 'htm',
 'xml',
 'yaml',
 'yml',
]);

// --- Bytes formatting -----------------------------------------------------

/**
 * Convert a byte count to a short human string.
 *
 * @example
 * formatBytes(0) === '0 B'
 * formatBytes(1024) === '1.0 KB'
 * formatBytes(5_242_880) === '5.0 MB'
 * formatBytes(NaN) === STATUS_NO_VALUE
 *
 * Identical algorithm to 's `formatBytes` (deliberately kept
 * separate to keep each extension bundle independent; a shared
 * `extensions/shared/text-utils.ts` extraction is tracked separately).
 */
export function formatBytes(bytes: number): string {
 if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
 if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
 return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- Encoding -------------------------------------------------------------

/**
 * Map the raw `fileContent.encoding` value to a human-friendly label for the
 * status bar.
 */
export function parseEncoding(enc: 'utf8' | 'base64'): string {
 return enc === 'base64' ? 'Base64' : 'UTF-8';
}

// --- Search match counting -----------------------------------------------
// 
// The status bar's "Matches" field and the replace-all toast both need to
// know how many occurrences of a search pattern exist in the current
// document. CodeMirror's `SearchQuery.matchAll` exists but requires a full
// `EditorState` and parses the document as a CodeMirror `Text`. For the
// status bar we only need a fast pure-function count, so we re-implement
// just the counting half here.
// 
// Behavior mirrors the @codemirror/search search cursor (see
// node_modules/@codemirror/search/dist/index.js:609-740):
// - `caseSensitive` toggles lowercase normalization
// - `wholeWord` wraps with `\b...\b` boundaries (in the regex branch the
// search extension uses a more sophisticated charCategorizer; for our
// status-bar use case the `\b` fallback is good enough and the search
// panel's own count remains the source of truth for highlighting)
// - `regex` switches to the `RegExp` engine; invalid patterns return 0
// - Plain (non-regex) queries decode `\n` / `\r` / `\t` for parity with
// the search panel's `SearchQuery.unquote` behavior

export interface CountMatchesOptions {
 /** Case sensitive (default false). */
 caseSensitive?: boolean;
 /** Match whole words only (default false; uses `\b` boundaries in plain mode). */
 wholeWord?: boolean;
 /** Treat `query` as a regular expression (default false). */
 regex?: boolean;
 /** Multiline flag for regex mode — `^` and `$` match per line. */
 multiline?: boolean;
}

/**
 * Decode the same escape sequences the search panel treats as literal
 * newlines / tabs / carriage returns in non-regex queries.
 *
 * Mirrors `SearchQuery.unquote` (index.js:565-568) so the status-bar
 * counter agrees with what the panel actually searches for.
 */
function unquote(s: string): string {
 return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

/**
 * Count occurrences of `query` in `text`. Empty queries return 0. Invalid
 * regex patterns return 0 (they don't throw — the search panel itself shows
 * an error indicator, but for the status bar / toast we just report 0).
 */
export function countMatches(
 query: string,
 text: string,
 options: CountMatchesOptions = {},
): number {
 if (!query) return 0;
 if (text === '') return 0;

 const caseSensitive = options.caseSensitive ?? false;
 const wholeWord = options.wholeWord ?? false;
 const regex = options.regex ?? false;
 const multiline = options.multiline ?? false;

 if (regex) {
 let re: RegExp;
 try {
 const flags =
 'g' +
 (multiline ? 'm' : '') +
 (caseSensitive ? '' : 'i');
 re = new RegExp(query, flags);
 } catch {
 return 0;
 }
 let count = 0;
 let guard = 0;
 for (;;) {
 const m = re.exec(text);
 if (m === null) break;
 count++;
 // Guard against zero-width matches looping forever. `m[0].length === 0`
 // means the engine matched an empty string at `re.lastIndex`; nudge it
 // forward by one code unit so progress can be made.
 if (m[0].length === 0) {
 if (re.lastIndex >= text.length) break;
 re.lastIndex++;
 }
 if (++guard > 1_000_000) break; // pathological regex safety
 }
 return count;
 }

 // Plain string mode — decode \n / \r / \t to match the search panel.
 const needleRaw = unquote(query);
 const needle = caseSensitive ? needleRaw : needleRaw.toLowerCase();
 const hay = caseSensitive ? text : text.toLowerCase();

 if (wholeWord) {
 // Escape regex meta-characters in the needle so the user can search for
 // a literal whole word that happens to contain ".", "+", etc.
 const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const reWhole = new RegExp(`\\b${escaped}\\b`, 'g');
 const matches = hay.match(reWhole);
 return matches ? matches.length : 0;
 }

 let count = 0;
 let idx = 0;
 const step = needle.length || 1;
 while ((idx = hay.indexOf(needle, idx)) !== -1) {
 count++;
 idx += step;
 }
 return count;
}

// --- Cursor / document stats ----------------------------------------------

/** Cursor + document statistics extracted from a CodeMirror `EditorState`. */
export interface CursorStats {
 /** 1-based line number of the cursor (or selection head). */
 line: number;
 /** 1-based column number (character offset within the line). */
 col: number;
 /** Total number of characters in the document. */
 docLength: number;
 /** Length of the main selection; 0 when the cursor is collapsed. */
 selectionLength: number;
}

/**
 * Compute cursor position + document stats from a CodeMirror state.
 *
 * Pure function — no DOM, no view instance. Tests construct an `EditorState`
 * directly via `EditorState.create({ doc, selection })`.
 *
 * Note on columns: CodeMirror counts UTF-16 code units, not Unicode
 * codepoints. Surrogate pairs occupy one column. This matches what the user
 * sees when they press arrow keys.
 */
export function getCursorPosition(state: EditorState): CursorStats {
 const { head, anchor } = state.selection.main;
 const lineObj = state.doc.lineAt(head);
 return {
 line: lineObj.number,
 col: head - lineObj.from + 1,
 docLength: state.doc.length,
 selectionLength: Math.abs(head - anchor),
 };
}

// --- Font size clamping ---------------------------------------------------

/**
 * Clamp a font size to [MIN_FONT_SIZE, MAX_FONT_SIZE] and round to nearest
 * integer. Non-finite inputs short-circuit to `DEFAULT_FONT_SIZE`.
 */
export function clampFontSize(px: number): number {
 if (!Number.isFinite(px)) return DEFAULT_FONT_SIZE;
 const rounded = Math.round(px);
 if (rounded < MIN_FONT_SIZE) return MIN_FONT_SIZE;
 if (rounded > MAX_FONT_SIZE) return MAX_FONT_SIZE;
 return rounded;
}

/** Step a font size by `FONT_SIZE_STEP` in the given direction, clamped. */
export function stepFontSize(px: number, direction: 1 | -1): number {
 return clampFontSize(px + FONT_SIZE_STEP * direction);
}

// --- localStorage persistence --------------------------------------------

const FONT_SIZE_KEY = 'whale.text-editor.fontSize';
const WRAP_KEY = 'whale.text-editor.wrap';

/**
 * Read the persisted font size, falling back to `DEFAULT_FONT_SIZE` when:
 * - the key is unset
 * - the stored value is not a valid integer in [MIN, MAX]
 * - localStorage throws (privacy mode, sandboxed iframe)
 */
export function loadFontSize(): number {
 try {
 const raw = window.localStorage.getItem(FONT_SIZE_KEY);
 if (!raw) return DEFAULT_FONT_SIZE;
 const n = Number(raw);
 return clampFontSize(n);
 } catch {
 return DEFAULT_FONT_SIZE;
 }
}

/** Persist the font size. Silently no-ops on storage errors. */
export function persistFontSize(px: number): void {
 try {
 window.localStorage.setItem(FONT_SIZE_KEY, String(clampFontSize(px)));
 } catch {
 // privacy mode / quota exceeded — ignore
 }
}

/** Read the persisted wrap mode; defaults to 'nowrap'. */
export function loadWrapMode(): WrapMode {
 try {
 return window.localStorage.getItem(WRAP_KEY) === 'wrap' ? 'wrap' : 'nowrap';
 } catch {
 return 'nowrap';
 }
}

/** Persist the wrap mode. Silently no-ops on storage errors. */
export function persistWrapMode(mode: WrapMode): void {
 try {
 window.localStorage.setItem(WRAP_KEY, mode);
 } catch {
 // privacy mode / quota exceeded — ignore
 }
}

// --- Extension capability predicates -------------------------------------

/** True when `path` has an extension whose language parser provides
 * fold-aware nodes for `foldGutter` to display. */
export function supportsFolding(path: string): boolean {
 const dot = path.lastIndexOf('.');
 if (dot < 0 || dot === path.length - 1) return false;
 const ext = path.slice(dot + 1).toLowerCase();
 return FOLDABLE_EXTENSIONS.has(ext);
}