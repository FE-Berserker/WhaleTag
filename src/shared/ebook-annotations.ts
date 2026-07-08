/**
 * Ebook-viewer annotation persistence (`.whale/ebook-annotations/<basename>.json`).
 *
 * The ebook-viewer extension stores its user data — reading preferences,
 * highlights, bookmarks, and notes — in a per-file JSON file under `.whale/`.
 * This is a forward-only contract; the `version` field lets us migrate the
 * schema later without losing user data.
 *
 * Storage shape (version 1):
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-07-02T10:00:00.000Z",
 *     "prefs": { ... },
 *     "highlights": [ ... ],
 *     "bookmarks":  [ ... ],
 *     "notes":      [ ... ]
 *   }
 */

export const EBOOK_ANNOTATIONS_VERSION = 1;

export type EbookThemePref = 'light' | 'dark' | 'sepia';
export type EbookScrollMode = 'page' | 'continuous';
export type EbookCbzSpreadMode = 'single' | 'double-ltr' | 'double-rtl';
export type EbookHighlightColor = 'yellow' | 'green' | 'pink' | 'blue';

export interface EbookPrefs {
  /** 'sepia' is local to ebook-viewer; host's `setTheme` stays `light|dark`. */
  theme: EbookThemePref;
  fontSize: number; // 10..32, matches FONT_MIN/MAX in index.ts
  fontFamily: string; // CSS font-family value
  lineHeight: number; // 1.0..2.4
  marginPx: number; // 0..96
  /** EPUB/FB2 only — CBZ ignores. */
  scrollMode: EbookScrollMode;
  /** CBZ only. */
  cbzSpreadMode: EbookCbzSpreadMode;
}

export interface EbookHighlight {
  id: string;
  /** EpubChapter.id, or 'fb2' for FB2 (which is a single document). */
  chapterId: string;
  /** Char offsets into the SANITIZED chapter plain text (see plain-text.ts). */
  start: number;
  end: number;
  /** First 80 chars of the highlighted text, for list view. */
  text: string;
  color: EbookHighlightColor;
  createdAt: string; // ISO-8601
}

export interface EbookBookmark {
  id: string;
  chapterId: string;
  /** 0..1 within the chapter. */
  scrollRatio: number;
  createdAt: string;
}

export interface EbookNote {
  id: string;
  /** Optional reference to a highlight. */
  highlightId?: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface EbookAnnotations {
  version: number;
  updatedAt: string;
  prefs: EbookPrefs;
  highlights: EbookHighlight[];
  bookmarks: EbookBookmark[];
  notes: EbookNote[];
}

/** Sensible defaults for a fresh annotation file. */
export function defaultEbookAnnotations(): EbookAnnotations {
  return {
    version: EBOOK_ANNOTATIONS_VERSION,
    updatedAt: new Date(0).toISOString(),
    prefs: {
      theme: 'light',
      fontSize: 16,
      fontFamily: 'Georgia, "Times New Roman", serif',
      lineHeight: 1.7,
      marginPx: 24,
      scrollMode: 'page',
      cbzSpreadMode: 'single',
    },
    highlights: [],
    bookmarks: [],
    notes: [],
  };
}