import path from 'path';
import { promises as fsp } from 'fs';
import { META_DIR } from '../shared/whale-meta';
import {
  defaultEbookAnnotations,
  EBOOK_ANNOTATIONS_VERSION,
  type EbookAnnotations,
} from '../shared/ebook-annotations';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';

/**
 * Per-ebook annotation persistence (`.whale/ebook-annotations/<basename>.json`).
 *
 * Storage layout (mirrors `revisions.ts`):
 *   <ebook-dir>/.whale/ebook-annotations/<ebook-basename>.json
 *
 * Writes are serialized through `withLock(dir, ...)` so concurrent updates
 * (e.g. font-size slider + scroll position write fired in the same tick)
 * cannot interleave and lose state. Reads bypass the lock — they never mutate
 * state, and a stale read is harmless given the next write is the authoritative
 * snapshot from the extension.
 *
 * The file is sparse: when the extension owns nothing worth saving (default
 * prefs, no highlights, no bookmarks, no notes), the writer deletes the file
 * rather than leaving an empty shell behind.
 */

const EBOOK_ANNOTATIONS_DIR = 'ebook-annotations';

/** Path of the annotation file for `filePath`. */
export function annotationsPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, META_DIR, EBOOK_ANNOTATIONS_DIR, `${base}.json`);
}

/** True when the payload carries nothing the reader would want persisted. */
function isEmpty(annotations: EbookAnnotations): boolean {
  return (
    annotations.highlights.length === 0 &&
    annotations.bookmarks.length === 0 &&
    annotations.notes.length === 0 &&
    annotations.prefs.theme === 'light' &&
    annotations.prefs.fontSize === 16 &&
    annotations.prefs.fontFamily === 'Georgia, "Times New Roman", serif' &&
    annotations.prefs.lineHeight === 1.7 &&
    annotations.prefs.marginPx === 24 &&
    annotations.prefs.scrollMode === 'page' &&
    annotations.prefs.cbzSpreadMode === 'single'
  );
}

/**
 * Reads the annotation file for `filePath`. Returns `null` when the file does
 * not exist or cannot be parsed (treat as "fresh book"). Always returns a
 * shape with `version === EBOOK_ANNOTATIONS_VERSION` so callers do not have to
 * defend against missing fields.
 */
export async function readEbookAnnotations(
  filePath: string
): Promise<EbookAnnotations | null> {
  try {
    const data = await fsp.readFile(annotationsPathFor(filePath), 'utf8');
    const parsed = JSON.parse(data);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== EBOOK_ANNOTATIONS_VERSION
    ) {
      return null;
    }
    // Merge with defaults so a partially-migrated file still gives the
    // extension a complete shape to work with.
    return {
      ...defaultEbookAnnotations(),
      ...parsed,
      prefs: { ...defaultEbookAnnotations().prefs, ...(parsed.prefs ?? {}) },
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    };
  } catch {
    return null;
  }
}

/**
 * Atomically writes `annotations` for `filePath`. Concurrent writes to the
 * same ebook serialize through the per-directory lock so the last caller's
 * snapshot wins (the extension owns the authoritative state and writes the
 * full payload — there is no read-modify-write here).
 *
 * When `annotations` is empty, the file is deleted so unconfigured books
 * leave no trace.
 */
export async function writeEbookAnnotations(
  filePath: string,
  annotations: EbookAnnotations
): Promise<void> {
  await withLock(path.dirname(filePath), async () => {
    const target = annotationsPathFor(filePath);
    if (isEmpty(annotations)) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const stamped: EbookAnnotations = {
      ...annotations,
      version: EBOOK_ANNOTATIONS_VERSION,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(target, stamped);
  });
}