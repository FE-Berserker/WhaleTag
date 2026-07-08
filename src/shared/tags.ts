import { TAG_SEPARATOR } from './whale-meta';

/**
 * Filename-embedded tag utilities (Whale's default tagging mode, mirroring
 * TagSpaces): tags live in the basename as `name[tag1 tag2].ext`.
 *
 * Pure & dependency-free so both the main process (indexer) and the renderer
 * can use them.
 */

/** Splits a filename into { base, ext } where `ext` includes the leading dot. */
export function splitNameExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' }; // no ext, or leading-dot file
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** Base (no extension) with all `[...]` tag groups removed and trimmed. */
export function stripTagBrackets(name: string): string {
  const { base } = splitNameExt(name);
  return base.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();
}

/** Full filename with `[...]` tag groups removed, extension kept: `a[t1 t2].pdf` → `a.pdf`. */
export function stripTagsFromName(name: string): string {
  const { base, ext } = splitNameExt(name);
  return `${base.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim()}${ext}`;
}

/** Extracts tags embedded as `name[tag1 tag2].ext`. Unique, order-preserving. */
export function extractTags(name: string): string[] {
  const { base } = splitNameExt(name);
  const tags: string[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(base)) !== null) {
    for (const raw of m[1].split(/\s+/)) {
      const tag = raw.trim();
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  return tags;
}

/** Builds `base[tag1 tag2].ext` from an original name + tag list. */
export function generateFileName(name: string, tags: string[]): string {
  const { ext } = splitNameExt(name);
  const stripped = stripTagBrackets(name) || 'untitled';
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (clean.length === 0) return `${stripped}${ext}`;
  return `${stripped}[${clean.join(TAG_SEPARATOR)}]${ext}`;
}

/**
 * Parses free-form user input (whitespace separated) into a tag list.
 *
 * Splits on whitespace ONLY — not on commas — because some tags carry an
 * internal comma (e.g. `geo:lat,lng`). Splitting on commas would fracture a
 * geo tag into two junk tags on every edit/save round-trip. The canonical
 * separator is `TAG_SEPARATOR` (a space); see whale-meta.
 */
export function parseTagsInput(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const tag = raw.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** A file's effective tags = filename-embedded ∪ sidecar tags (unique). */
export function mergeTags(fileName: string, sidecarTags: string[] = []): string[] {
  return [...new Set([...extractTags(fileName), ...sidecarTags])];
}
