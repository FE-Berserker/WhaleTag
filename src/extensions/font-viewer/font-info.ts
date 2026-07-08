/**
 * font-viewer — opentype.js wrappers (DOM-free, runs under node:test).
 *
 * Responsibilities:
 *   1. Decode a raw font `ArrayBuffer` via opentype.js (synchronous).
 *   2. Project the OpenType `name` table onto a flat, UI-friendly shape.
 *   3. Derive variable-font axes (`wght`/`wdth`/`slnt`) and bold/italic flags
 *      from OS/2 `fsSelection`.
 *   4. Sort and group cmap codepoints by Unicode block (for the glyph grid).
 *
 * Browser-runtime call site: `parseFont(buffer)` from `index.ts`; tests
 * drive the pure helpers with synthetic opentype.Font objects (matching
 * the shim in `opentype.d.ts`), never with real font files.
 */
import opentype from 'opentype.js';
import type { Font as OpentypeFont } from 'opentype.js';

// --- Shape returned to the UI --------------------------------------------

/** Flat metadata used by the drawer "Metadata" tab. Empty string = absent. */
export interface FontMeta {
  family: string;
  subfamily: string;
  fullName: string;
  version: string;
  copyright: string;
  designer: string;
  manufacturer: string;
  license: string;
  psName: string;
  description: string;
}

/** Supported variable axes (only the three we surface in the toolbar). */
export interface VariableAxes {
  wght: { min: number; max: number; def: number } | null;
  wdth: { min: number; max: number; def: number } | null;
  slnt: { min: number; max: number; def: number } | null;
}

/** Static-style capabilities derived from OS/2 fsSelection. */
export interface StaticStyles {
  /** True if the font has at least one regular cut. */
  regular: boolean;
  /** True if the font has at least one bold (fsSelection bit 5). */
  bold: boolean;
  /** True if the font has at least one italic (fsSelection bit 0). */
  italic: boolean;
}

// --- Parse entry ----------------------------------------------------------

/**
 * Parse a font `ArrayBuffer` via opentype.js.
 *
 * Wraps the synchronous `opentype.parse` so the iframe side can do
 * `parseFont(bytes)` exactly once per `fileContent` and share the result
 * with the FontFace load (see index.ts).
 */
export function parseFont(buffer: ArrayBuffer): OpentypeFont {
  return opentype.parse(buffer);
}

// --- name-table projection ------------------------------------------------

/** Trim and un-define-empty. `''` and `'undefined'` both surface as `''`. */
function clean(value: string | undefined): string {
  if (!value) return '';
  // Some not-very-careful font vendors use the literal string 'undefined' or
  // 'None' for empty fields — normalize them so the UI can use a single
  // empty-string check.
  const trimmed = value.trim();
  if (
    trimmed === '' ||
    trimmed.toLowerCase() === 'undefined' ||
    trimmed.toLowerCase() === 'none' ||
    trimmed.toLowerCase() === 'n/a'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Pull the eight fields the drawer cares about out of the `name` table.
 *
 * Order of lookup per field: explicit key → English name table key →
 * `getEnglishName(...)` fallback. Failed lookups collapse to `''` so the
 * caller doesn't have to null-check.
 */
export function fontMetaFromFont(font: OpentypeFont): FontMeta {
  const n = font.tables.name ?? {};
  return {
    family: clean(n.preferredFamily ?? n.fontFamily ?? getEng(font, 'fontFamily')),
    subfamily: clean(n.preferredSubfamily ?? n.fontSubfamily ?? getEng(font, 'fontSubfamily')),
    fullName: clean(n.fullName ?? getEng(font, 'fullName')),
    version: clean(n.version ?? getEng(font, 'version')),
    copyright: clean(n.copyright ?? getEng(font, 'copyright')),
    designer: clean(n.designer ?? getEng(font, 'designer')),
    manufacturer: clean(n.manufacturer ?? getEng(font, 'manufacturer')),
    license: clean(n.license ?? getEng(font, 'license')),
    psName: clean(n.postScriptName ?? getEng(font, 'postScriptName')),
    description: clean(n.description ?? getEng(font, 'description')),
  };
}

function getEng(font: OpentypeFont, key: string): string | undefined {
  try {
    return font.getEnglishName(key);
  } catch {
    return undefined;
  }
}

// --- Variable axes --------------------------------------------------------

/**
 * Project the font's `fvar` table onto the three axes our UI exposes.
 * Returns `null` for an axis if the font doesn't declare it (or isn't a
 * variable font at all).
 */
export function variableAxesFromFont(font: OpentypeFont): VariableAxes {
  const axes = font.tables.fvar?.axes;
  if (!axes) return { wght: null, wdth: null, slnt: null };
  return {
    wght: pickAxis(axes, 'wght'),
    wdth: pickAxis(axes, 'wdth'),
    slnt: pickAxis(axes, 'slnt'),
  };
}

function pickAxis(
  axes: { tag: string; minValue: number; defaultValue: number; maxValue: number }[],
  tag: string,
): { min: number; max: number; def: number } | null {
  const a = axes.find((x) => x.tag === tag);
  if (!a) return null;
  return { min: a.minValue, max: a.maxValue, def: a.defaultValue };
}

// --- Static-style capabilities -------------------------------------------

/** OS/2 `fsSelection` bit flags we care about. */
const FS_REGULAR = 1 << 5; // bit 5 = REGULAR (1<<5 = 32)
const FS_ITALIC = 1 << 0; // canonical ITALIC flag is bit 0 (= 1)

/**
 * Read OS/2 fsSelection and surface a 3-flag view of style support.
 * Defaults to "regular-only" when the OS/2 table is missing entirely —
 * matches the behavior of fonts that predate the OS/2 spec. When the
 * table is present, the REGULAR bit (bit 5) is authoritative: a bold cut
 * is NOT a regular cut, so we don't try to infer "regular" from "no bold,
 * no italic" — many fonts leave fsSelection at 0 without that meaning
 * anything.
 */
export function staticStylesFromFont(font: OpentypeFont): StaticStyles {
  const os2 = font.tables.os2;
  if (!os2 || typeof os2.fsSelection !== 'number') {
    return { regular: true, bold: false, italic: false };
  }
  const fs = os2.fsSelection;
  const regular = (fs & FS_REGULAR) !== 0;
  const italic = (fs & FS_ITALIC) !== 0;
  // OS/2 doesn't have a dedicated "bold" bit — derive from usWeightClass
  // (≥ 600 is conventionally bold). Chrome and FontFaceSet use the same
  // threshold, so we match their behavior.
  const weight = typeof os2.usWeightClass === 'number' ? os2.usWeightClass : 400;
  const bold = weight >= 600;
  return { regular, bold, italic };
}

// --- cmap grouping --------------------------------------------------------

/**
 * Return a sorted array of Unicode codepoints the font advertises in its
 * cmap. Empty array if the table is missing or empty.
 */
export function getCmapChars(font: OpentypeFont): number[] {
  const map = font.tables.cmap?.glyphIndexMap;
  if (!map) return [];
  const codepoints = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return codepoints;
}

/** A group of consecutive codepoints that share the same Unicode block. */
export interface UnicodeBlock {
  /** Block name (e.g. "Basic Latin"). */
  name: string;
  /** Range start (inclusive). */
  start: number;
  /** Range end (inclusive). */
  end: number;
  /** Codepoints inside the block, sorted ascending. */
  codepoints: number[];
}

/**
 * Group sorted codepoints into Unicode blocks. A "block" is the contiguous
 * range [start, end] declared by Unicode; the function bins each codepoint
 * into the block it belongs to. Codepoints in unknown / unrepresented
 * blocks land in a single fallback group with name "Other".
 *
 * Hard-coded ranges cover the common blocks (Basic Latin, Latin-1, IPA,
 * Greek, Cyrillic, General Punctuation, CJK). Anything outside the table
 * (e.g. Private Use Area) goes into "Other".
 */
export function groupCharsByBlock(codepoints: number[]): UnicodeBlock[] {
  if (codepoints.length === 0) return [];
  const buckets = new Map<string, { range: [number, number]; chars: number[] }>();
  for (const cp of codepoints) {
    const block = findBlock(cp);
    const key = block ? block.name : 'Other';
    if (!buckets.has(key)) {
      buckets.set(key, { range: block ? [block.start, block.end] : [cp, cp], chars: [] });
    }
    buckets.get(key)!.chars.push(cp);
  }
  // Order blocks by their starting codepoint (first group's start).
  const ordered = Array.from(buckets.entries())
    .map(([name, v]) => ({
      name,
      start: v.range[0],
      end: v.range[1],
      codepoints: v.chars,
    }))
    .sort((a, b) => a.start - b.start);
  return ordered;
}

interface HardBlock {
  name: string;
  start: number;
  end: number;
}

// Last entry must always be a catch-all with `end: Infinity` to absorb
// anything not explicitly listed.
const BLOCKS: HardBlock[] = [
  { name: 'Basic Latin', start: 0x0000, end: 0x007f },
  { name: 'Latin-1 Supplement', start: 0x0080, end: 0x00ff },
  { name: 'Latin Extended-A', start: 0x0100, end: 0x017f },
  { name: 'Latin Extended-B', start: 0x0180, end: 0x024f },
  { name: 'IPA Extensions', start: 0x0250, end: 0x02af },
  { name: 'Spacing Modifier Letters', start: 0x02b0, end: 0x02ff },
  { name: 'Combining Diacritical Marks', start: 0x0300, end: 0x036f },
  { name: 'Greek and Coptic', start: 0x0370, end: 0x03ff },
  { name: 'Cyrillic', start: 0x0400, end: 0x04ff },
  { name: 'General Punctuation', start: 0x2000, end: 0x206f },
  { name: 'Superscripts and Subscripts', start: 0x2070, end: 0x209f },
  { name: 'Currency Symbols', start: 0x20a0, end: 0x20cf },
  { name: 'Arrows', start: 0x2190, end: 0x21ff },
  { name: 'Mathematical Operators', start: 0x2200, end: 0x22ff },
  { name: 'Box Drawing', start: 0x2500, end: 0x257f },
  { name: 'Geometric Shapes', start: 0x25a0, end: 0x25ff },
  { name: 'CJK Unified Ideographs', start: 0x4e00, end: 0x9fff },
  { name: 'CJK Compatibility Ideographs', start: 0xf900, end: 0xfaff },
  { name: 'Hiragana', start: 0x3040, end: 0x309f },
  { name: 'Katakana', start: 0x30a0, end: 0x30ff },
  { name: 'Hangul Syllables', start: 0xac00, end: 0xd7af },
  { name: 'Private Use Area', start: 0xe000, end: 0xf8ff },
  { name: 'Other', start: -1, end: Infinity },
];

function findBlock(cp: number): HardBlock | null {
  for (const b of BLOCKS) {
    if (cp >= b.start && cp <= b.end) {
      return b.name === 'Other' ? null : b;
    }
  }
  return null;
}

// --- Glyph cell count guard ----------------------------------------------

/**
 * Cap a glyph list for the on-screen grid. The grid UI warns when the
 * truncation kicks in.
 */
export const GLYPH_GRID_CAP = 2000;

/** Truncate a flat codepoint list to the first GLYPH_GRID_CAP entries. */
export function capGlyphList(codepoints: number[]): number[] {
  if (codepoints.length <= GLYPH_GRID_CAP) return codepoints;
  return codepoints.slice(0, GLYPH_GRID_CAP);
}
