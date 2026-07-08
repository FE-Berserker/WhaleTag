// Ambient types for `opentype.js` (ships no .d.ts and has no @types package).
// Shapes taken from the runtime API docs at
// https://opentype.js.org/ — only the subset used by font-info.ts is
// declared here. Anything else is intentionally omitted to keep the surface
// narrow and stable across minor versions.
declare module 'opentype.js' {
  /** Name table — OpenType spec indexes 0..22, exposed as string fields. */
  export interface NameTable {
    copyright?: string;
    fontFamily?: string;
    fontSubfamily?: string;
    uniqueID?: string;
    fullName?: string;
    version?: string;
    postScriptName?: string;
    trademark?: string;
    manufacturer?: string;
    designer?: string;
    description?: string;
    license?: string;
    /** The opentype.js parser prefers English record when present. */
    [localized: string]: string | undefined;
  }

  /** OS/2 table — only fsSelection, usWeightClass, usWidthClass. */
  export interface OS2Table {
    fsSelection?: number;
    usWeightClass?: number;
    usWidthClass?: number;
  }

  /** cmap table — only the codepoint → glyph-index map. */
  export interface CmapTable {
    glyphIndexMap?: Record<number, number>;
  }

  /**
   * Variable-font axis descriptor. OpenType fvar tag, e.g. 'wght' / 'wdth' /
   * 'slnt'. Only the three common axes are exercised by font-info.ts.
   */
  export interface FvarAxis {
    tag: string;
    minValue: number;
    defaultValue: number;
    maxValue: number;
  }

  export interface FvarTable {
    axes?: FvarAxis[];
  }

  /** All tables we touch. */
  export interface FontTables {
    name?: NameTable;
    os2?: OS2Table;
    cmap?: CmapTable;
    fvar?: FvarTable;
    [tag: string]: unknown;
  }

  /** The glyph is mostly opaque; we only need its `index` for size. */
  export interface FontGlyph {
    index: number;
    name?: string;
    unicode?: number;
  }

  export interface Font {
    numGlyphs: number;
    unitsPerEm: number;
    glyphs: { length: number; get(i: number): FontGlyph };
    tables: FontTables;

    /**
     * Return the English (or first available) name record for the given key.
     * `key` is one of the spec indexes: 'fontFamily', 'copyright', etc.
     */
    getEnglishName(key: string): string | undefined;

    /**
     * `toArrayBuffer` is deprecated on instances but still safe to call;
     * we don't need it in this extension but include the type for completeness.
     */
    toArrayBuffer?(): ArrayBuffer;
  }

  /** Main entry. `parse` accepts ArrayBuffer / Uint8Array / Buffer. */
  function parse(buffer: ArrayBuffer | Uint8Array | Buffer): Font;

  const opentype: { parse: typeof parse };
  export default opentype;
}
