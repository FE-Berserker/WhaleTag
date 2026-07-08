/**
 * font-viewer — unit tests for the opentype.js wrappers in font-info.ts.
 *
 * Run under `node:test` via the existing `npm test` script.
 *
 * Strategy: the pure helpers (fontMetaFromFont / variableAxesFromFont /
 * staticStylesFromFont / getCmapChars / groupCharsByBlock / capGlyphList)
 * are driven by synthetic `opentype.Font`-shaped mocks — not real font
 * files. This keeps the suite hermetic and fast.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Font as OpentypeFont } from 'opentype.js';

import {
  fontMetaFromFont,
  variableAxesFromFont,
  staticStylesFromFont,
  getCmapChars,
  groupCharsByBlock,
  capGlyphList,
  GLYPH_GRID_CAP,
} from './font-info';

/** Build a minimal mock matching the shim in opentype.d.ts. */
function makeFont(
  opts: Partial<{
    name: Record<string, string>;
    os2: { fsSelection?: number; usWeightClass?: number; usWidthClass?: number };
    cmap: Record<number, number>;
    fvar: { tag: string; minValue: number; defaultValue: number; maxValue: number }[];
    englishNames: Record<string, string>;
  }> = {},
): OpentypeFont {
  const englishNames = opts.englishNames ?? {};
  return {
    numGlyphs: 100,
    unitsPerEm: 1000,
    glyphs: { length: 100, get: () => ({ index: 0 }) } as unknown as OpentypeFont['glyphs'],
    tables: {
      name: opts.name as never,
      os2: opts.os2 as never,
      cmap: { glyphIndexMap: opts.cmap } as never,
      fvar: opts.fvar ? { axes: opts.fvar } : undefined,
    },
    getEnglishName: (key: string) => englishNames[key],
  } as unknown as OpentypeFont;
}

describe('fontMetaFromFont', () => {
  it('returns empty strings when no tables are present', () => {
    const meta = fontMetaFromFont(makeFont());
    assert.equal(meta.family, '');
    assert.equal(meta.subfamily, '');
    assert.equal(meta.version, '');
  });

  it('reads fields from the name table directly', () => {
    const meta = fontMetaFromFont(
      makeFont({
        name: {
          fontFamily: 'Inter',
          fontSubfamily: 'Regular',
          version: 'Version 4.000',
          copyright: '© 2026 Rasmus Andersson',
        },
      }),
    );
    assert.equal(meta.family, 'Inter');
    assert.equal(meta.subfamily, 'Regular');
    assert.equal(meta.version, 'Version 4.000');
    assert.equal(meta.copyright, '© 2026 Rasmus Andersson');
  });

  it('prefers preferredFamily / preferredSubfamily when available', () => {
    const meta = fontMetaFromFont(
      makeFont({
        name: {
          fontFamily: 'Helvetica Now',
          preferredFamily: 'Helvetica',
          fontSubfamily: 'Display',
          preferredSubfamily: 'Display Medium',
        } as never,
      }),
    );
    assert.equal(meta.family, 'Helvetica');
    assert.equal(meta.subfamily, 'Display Medium');
  });

  it('falls back to getEnglishName when fields are missing from the name table', () => {
    const meta = fontMetaFromFont(
      makeFont({
        englishNames: {
          fontFamily: 'Arial',
          designer: 'Robin Caspar, Patricia Saunders',
        },
      }),
    );
    assert.equal(meta.family, 'Arial');
    assert.equal(meta.designer, 'Robin Caspar, Patricia Saunders');
  });

  it('treats "undefined" / "None" / "N/A" as empty', () => {
    const meta = fontMetaFromFont(
      makeFont({
        name: {
          designer: 'undefined',
          manufacturer: '  None  ',
          license: 'N/A',
        } as never,
      }),
    );
    assert.equal(meta.designer, '');
    assert.equal(meta.manufacturer, '');
    assert.equal(meta.license, '');
  });

  it('trims surrounding whitespace from all fields', () => {
    const meta = fontMetaFromFont(
      makeFont({
        name: { fontFamily: '  Lora  ' } as never,
      }),
    );
    assert.equal(meta.family, 'Lora');
  });
});

describe('variableAxesFromFont', () => {
  it('returns all-null axes for static fonts (no fvar)', () => {
    const axes = variableAxesFromFont(makeFont());
    assert.equal(axes.wght, null);
    assert.equal(axes.wdth, null);
    assert.equal(axes.slnt, null);
  });

  it('extracts the three exposed axes when fvar declares them', () => {
    const axes = variableAxesFromFont(
      makeFont({
        fvar: [
          { tag: 'wght', minValue: 100, defaultValue: 400, maxValue: 900 },
          { tag: 'wdth', minValue: 75, defaultValue: 100, maxValue: 125 },
          { tag: 'slnt', minValue: -12, defaultValue: 0, maxValue: 0 },
          { tag: 'opsz', minValue: 8, defaultValue: 16, maxValue: 144 }, // ignored
        ],
      }),
    );
    assert.deepEqual(axes.wght, { min: 100, max: 900, def: 400 });
    assert.deepEqual(axes.wdth, { min: 75, max: 125, def: 100 });
    assert.deepEqual(axes.slnt, { min: -12, max: 0, def: 0 });
  });

  it('returns null for axes the font does not declare', () => {
    const axes = variableAxesFromFont(
      makeFont({ fvar: [{ tag: 'wght', minValue: 300, defaultValue: 400, maxValue: 700 }] }),
    );
    assert.deepEqual(axes.wght, { min: 300, max: 700, def: 400 });
    assert.equal(axes.wdth, null);
    assert.equal(axes.slnt, null);
  });
});

describe('staticStylesFromFont', () => {
  it('falls back to "regular-only" when the OS/2 table is missing', () => {
    const styles = staticStylesFromFont(makeFont());
    assert.equal(styles.regular, true);
    assert.equal(styles.bold, false);
    assert.equal(styles.italic, false);
  });

  it('detects italic from fsSelection bit 0', () => {
    const styles = staticStylesFromFont(makeFont({ os2: { fsSelection: 1, usWeightClass: 400 } }));
    assert.equal(styles.italic, true);
    assert.equal(styles.bold, false);
  });

  it('detects bold from usWeightClass ≥ 600', () => {
    const styles = staticStylesFromFont(makeFont({ os2: { fsSelection: 0, usWeightClass: 700 } }));
    assert.equal(styles.bold, true);
    assert.equal(styles.italic, false);
    assert.equal(styles.regular, false); // bold cut ≠ regular cut
  });

  it('flags both bold and italic when both bits/metrics trigger', () => {
    const styles = staticStylesFromFont(makeFont({ os2: { fsSelection: 1, usWeightClass: 700 } }));
    assert.equal(styles.bold, true);
    assert.equal(styles.italic, true);
    assert.equal(styles.regular, false); // bold-italic ≠ regular either
  });
});

describe('getCmapChars', () => {
  it('returns an empty list when the cmap table is missing', () => {
    assert.deepEqual(getCmapChars(makeFont()), []);
  });

  it('returns an empty list when the cmap table has no glyphIndexMap', () => {
    assert.deepEqual(getCmapChars(makeFont({ cmap: {} })), []);
  });

  it('returns sorted codepoints, dropping .notdef (0) and invalid entries', () => {
    const chars = getCmapChars(
      makeFont({
        cmap: {
          65: 36, // 'A'
          97: 50, // 'a'
          0: 0, // .notdef — must be dropped
        },
      }),
    );
    assert.deepEqual(chars, [65, 97]);
  });
});

describe('groupCharsByBlock', () => {
  it('returns [] for an empty input', () => {
    assert.deepEqual(groupCharsByBlock([]), []);
  });

  it('bins Basic Latin codepoints into a single "Basic Latin" group', () => {
    const groups = groupCharsByBlock([0x41, 0x42, 0x5a]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'Basic Latin');
    assert.deepEqual(groups[0].codepoints, [0x41, 0x42, 0x5a]);
  });

  it('separates Basic Latin from Latin-1 Supplement and Greek', () => {
    const groups = groupCharsByBlock([0x41, 0xc0, 0x391]);
    const names = groups.map((g) => g.name).sort();
    assert.deepEqual(names, ['Basic Latin', 'Greek and Coptic', 'Latin-1 Supplement']);
  });

  it('puts unknown ranges into the "Other" bucket', () => {
    const groups = groupCharsByBlock([0x40, 0x18000 /* private plane extension */]);
    const others = groups.find((g) => g.name === 'Other');
    assert.ok(others, 'should produce an Other bucket');
    assert.ok(others!.codepoints.includes(0x18000));
  });

  it('keeps groups ordered by starting codepoint', () => {
    const groups = groupCharsByBlock([0x391, 0x41, 0xc0]);
    assert.equal(groups[0].name, 'Basic Latin');
    assert.equal(groups[1].name, 'Latin-1 Supplement');
    assert.equal(groups[2].name, 'Greek and Coptic');
  });
});

describe('capGlyphList', () => {
  it('passes through lists shorter than the cap', () => {
    const input = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(capGlyphList(input).length, 100);
  });

  it('truncates lists longer than the cap and exposes GLYPH_GRID_CAP', () => {
    const input = Array.from({ length: GLYPH_GRID_CAP + 500 }, (_, i) => i + 1);
    const out = capGlyphList(input);
    assert.equal(out.length, GLYPH_GRID_CAP);
    assert.equal(out[0], 1);
    assert.equal(out[GLYPH_GRID_CAP - 1], GLYPH_GRID_CAP);
  });

  it('handles empty input', () => {
    assert.deepEqual(capGlyphList([]), []);
  });
});
