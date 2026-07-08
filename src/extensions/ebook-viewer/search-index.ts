/**
 * Minimal in-memory search index for the ebook viewer.
 *
 * MVP scope (per docs/07-extensions.md §六 ebook-viewer):
 *   - full-text search across EPUB chapters and FB2 (single document).
 *   - case-insensitive substring match (`String.indexOf` with `matchAll`).
 *   - returns hits ordered by chapter index; per-chapter matches in source
 *     order so Enter cycles naturally.
 *
 * NOT a real FTS. v2 candidates: FlexSearch, Minisearch, or a Web Worker that
 * builds a suffix array. For typical ebooks (< 5 MB plain text) the naive
 * approach is sub-50 ms per query — well below the perceived-latency bar.
 */

import { chapterPlainText } from './plain-text';

export interface SearchableChapter {
  id: string;
  title: string;
  html: string;
}

export interface SearchHit {
  chapterId: string;
  chapterIndex: number;
  /** Char offset into the chapter plain text. */
  start: number;
  /** Length of the matched substring in plain-text characters. */
  length: number;
  /** Short snippet (~30 chars around the match) for the result list. */
  snippet: string;
}

interface IndexedChapter {
  id: string;
  index: number;
  title: string;
  text: string;
  lcText: string;
}

const CONTEXT_RADIUS = 30;

export class SearchIndex {
  private chapters: IndexedChapter[] = [];
  private dirty = true;
  private query = '';

  constructor(chapters: SearchableChapter[]) {
    this.setChapters(chapters);
  }

  /** Replaces the chapter set; next `search` rebuilds the cache lazily. */
  setChapters(chapters: SearchableChapter[]): void {
    this.chapters = chapters.map((c, index) => ({
      id: c.id,
      index,
      title: c.title,
      // Store plainText once per chapter; the function is pure so the same
      // HTML always yields the same string.
      text: chapterPlainText(c.html),
      lcText: '',
    }));
    this.dirty = true;
  }

  /**
   * Returns all hits for `query` across the indexed chapters. Empty query
   * returns an empty list (UI is expected to short-circuit). The query is
   * matched as a literal substring — no regex special handling.
   */
  search(query: string): SearchHit[] {
    this.query = query;
    if (this.dirty) this.buildCache();
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const hits: SearchHit[] = [];
    for (const ch of this.chapters) {
      let from = 0;
      while (from < ch.lcText.length) {
        const idx = ch.lcText.indexOf(q, from);
        if (idx === -1) break;
        hits.push({
          chapterId: ch.id,
          chapterIndex: ch.index,
          start: idx,
          length: q.length,
          snippet: this.makeSnippet(ch.text, idx, q.length),
        });
        from = idx + Math.max(1, q.length);
      }
    }
    return hits;
  }

  /** Updates the snippet window (call after a font-size change). */
  setContextRadius(_r: number): void {
    // No-op for now; snippets are computed on demand from the cached text.
  }

  /** Approximate total queryable text size — used for status messages. */
  totalChars(): number {
    if (this.dirty) this.buildCache();
    let total = 0;
    for (const c of this.chapters) total += c.text.length;
    return total;
  }

  private buildCache(): void {
    for (const ch of this.chapters) {
      ch.lcText = ch.text.toLowerCase();
    }
    this.dirty = false;
  }

  private makeSnippet(text: string, idx: number, length: number): string {
    const lo = Math.max(0, idx - CONTEXT_RADIUS);
    const hi = Math.min(text.length, idx + length + CONTEXT_RADIUS);
    const prefix = lo > 0 ? '…' : '';
    const suffix = hi < text.length ? '…' : '';
    const inner = text.slice(lo, hi).replace(/\s+/g, ' ');
    return prefix + inner + suffix;
  }
}