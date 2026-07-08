/**
 * Structured search query shared between the renderer UI and the main-process
 * SQL layer (`src/main/index-db.ts`). Pure types + helpers — no IO, no
 * Node/DOM deps — so it sits safely in `shared`.
 */

/** Match mode for the set of required tags. */
export type TagMatch = 'all' | 'any';
/** Which kinds of entries to include. */
export type TypeFilter = 'any' | 'files' | 'folders';

/**
 * A structured advanced-search query, applied by `index-db.ts advancedQuery`.
 * All fields are ANDed; an unset field (empty string / empty array / null)
 * imposes no constraint.
 */
export interface SearchQuery {
  /** Case-insensitive substring the file name must contain. */
  text: string;
  /** Required tags (combined per {@link tagMatch}). */
  tags: string[];
  tagMatch: TagMatch;
  /** Tags that must NOT be present. */
  excludeTags: string[];
  /** Restrict to files, folders, or both. */
  type: TypeFilter;
  /** Allowed extensions (lowercase, no dot). Empty = any. Files only. */
  extensions: string[];
  /** Minimum / maximum size in bytes (files only). */
  sizeMinBytes: number | null;
  sizeMaxBytes: number | null;
  /** Modified-time window, epoch milliseconds (inclusive). */
  modifiedAfter: number | null;
  modifiedBefore: number | null;
}

export function emptyQuery(): SearchQuery {
  return {
    text: '',
    tags: [],
    tagMatch: 'all',
    excludeTags: [],
    type: 'any',
    extensions: [],
    sizeMinBytes: null,
    sizeMaxBytes: null,
    modifiedAfter: null,
    modifiedBefore: null,
  };
}

/** True when the query imposes no constraint at all (nothing to search). */
export function isQueryEmpty(q: SearchQuery): boolean {
  return (
    !q.text.trim() &&
    q.tags.length === 0 &&
    q.excludeTags.length === 0 &&
    q.type === 'any' &&
    q.extensions.length === 0 &&
    q.sizeMinBytes === null &&
    q.sizeMaxBytes === null &&
    q.modifiedAfter === null &&
    q.modifiedBefore === null
  );
}

/** Parses a comma/space-separated extension string into normalized tokens. */
export function parseExtensions(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}
