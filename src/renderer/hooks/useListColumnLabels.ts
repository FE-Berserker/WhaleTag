import { useMemo } from 'react';
import type { TFunction } from 'i18next';

/** Captions for the four list columns, in header/cell order (tags are a chip stack). */
export interface ListColumnLabels {
  name: string;
  tags: string;
  size: string;
  modified: string;
}

/**
 * Build the list column captions from a translator.
 *
 * Pure so it can be unit-tested without React; the hook below adds the stable
 * identity the memoized header needs.
 */
export function listColumnLabels(t: TFunction): ListColumnLabels {
  return {
    name: t('name'),
    tags: t('tags'),
    size: t('size'),
    modified: t('modified'),
  };
}

/**
 * Reference-stable column captions for `memo(FileListHeader)` and
 * `memo(RowColumnLabels)`.
 *
 * The call sites used to inline `{ name: t('name'), ... }` in JSX, which
 * allocates a fresh object on every FileList render (selection ticks, scroll,
 * thumbnails) — a new prop identity that forced the memoized header to
 * re-render on every tick. Memoizing on `t` keeps the identity stable while
 * still following a language change (i18next hands out a new `t` then).
 */
export function useListColumnLabels(t: TFunction): ListColumnLabels {
  return useMemo(() => listColumnLabels(t), [t]);
}
