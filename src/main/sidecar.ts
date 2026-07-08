import path from 'path';
import { promises as fsp } from 'fs';
import {
  META_DIR,
  FOLDER_SIDECAR_FILE,
  FOLDER_META_FILE,
  FOLDER_INDEX_FILE,
  FOLDER_FULLTEXT_FILE,
  SIDECAR_VERSION,
  type SidecarMeta,
  type AggregatedSidecar,
} from '../shared/whale-meta';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';

/**
 * Aggregated per-file sidecar store. Instead of one `<file>.json` per file
 * (which scales to thousands of tiny files in a big directory), every file's
 * tags/color/description in a directory live together in `.whale/wsd.json`,
 * keyed by basename:
 *
 *   { "version": 1, "files": { "my-file.txt": { "tags": ["work"], ... } } }
 *
 * Files with no tags/color/description are omitted entirely (sparse), so a
 * mostly-untagged directory produces no sidecar at all. Public functions keep
 * the old per-file signatures (readSidecar / writeSidecar / moveSidecar / ...),
 * so the IPC contract is unchanged — only the on-disk layout moves. See plan §6.6.
 *
 * Concurrency: each directory's wsd.json is mutated under a per-directory lock
 * (`dir-lock.ts`), so batch tagging (many writeSidecar calls into one dir) can't
 * interleave its read-modify-write and clobber another. Steady-state reads are
 * lock-free; the lock is taken only when a one-time legacy migration may run.
 *
 * Legacy migrations:
 *  1. The first time a directory with old per-file `<file>.json` sidecars is
 *     touched, they are folded into wsd.json and the originals deleted —
 *     lazily, per-directory, and idempotently.
 *  2. Old wsd.json entries that still carry parallel `lat`/`lng` fields (the
 *     pre-2026-06-30 storage layout) are upgraded to a single `geo:lat,lng`
 *     tag inside the `tags` array on read. The `lat`/`lng` fields are dropped
 *     from the schema; legacy data is migrated in place on first read.
 */

/** `.whale/` files that end in `.json`/`.jsonl` but are NOT legacy sidecars. */
const RESERVED_META_FILES = new Set([
  FOLDER_SIDECAR_FILE, // wsd.json
  FOLDER_META_FILE, // wsm.json
  FOLDER_INDEX_FILE, // wsi.json
  FOLDER_FULLTEXT_FILE, // wsft.jsonl
]);

/** Path of a directory's aggregated sidecar file. */
function wsdPath(dirPath: string): string {
  return path.join(dirPath, META_DIR, FOLDER_SIDECAR_FILE);
}

/** Legacy per-file sidecar path (`<dir>/.whale/<file>.json`) — migration only. */
function legacySidecarPath(filePath: string): string {
  return path.join(path.dirname(filePath), META_DIR, `${path.basename(filePath)}.json`);
}

/** Reads wsd.json; null if missing or invalid. Does NOT migrate. */
async function loadWsd(dirPath: string): Promise<AggregatedSidecar | null> {
  try {
    const data = await fsp.readFile(wsdPath(dirPath), 'utf8');
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.files &&
      typeof parsed.files === 'object'
    ) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : SIDECAR_VERSION,
        files: parsed.files as Record<string, SidecarMeta>,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Legacy `lat`/`lng` shape (pre-2026-06-30). Kept here so we can read old
 * wsd.json entries and migrate them in place to the tag-only format.
 */
interface LegacySidecarMeta extends SidecarMeta {
  lat?: number;
  lng?: number;
}

/**
 * Migrate any legacy `lat`/`lng` field on a sidecar entry into a `geo:lat,lng`
 * tag in `tags`. The tag is the single source of truth for a file's location
 * (see `whale-meta.ts` SidecarMeta). Returns the migrated entry plus a flag
 * indicating whether the on-disk entry needs rewriting.
 */
function migrateLatLngToTag(meta: LegacySidecarMeta): {
  next: SidecarMeta;
  changed: boolean;
} {
  if (
    typeof meta.lat !== 'number' ||
    typeof meta.lng !== 'number' ||
    Number.isNaN(meta.lat) ||
    Number.isNaN(meta.lng)
  ) {
    // Strip any stray lat/lng (defensive — shouldn't exist post-migration).
    if ('lat' in meta || 'lng' in meta) {
      const { lat: _lat, lng: _lng, ...rest } = meta;
      return { next: rest, changed: true };
    }
    return { next: meta, changed: false };
  }

  const geoTag = `geo:${meta.lat.toFixed(6)},${meta.lng.toFixed(6)}`;
  const existing = meta.tags ?? [];
  // Don't append a duplicate if a geo: tag is already present (the user might
  // have manually added one that doesn't match the lat/lng — keep theirs).
  if (existing.some((t) => t.startsWith('geo:'))) {
    const { lat: _lat, lng: _lng, ...rest } = meta;
    return { next: rest, changed: true };
  }
  return {
    next: { ...meta, tags: [...existing, geoTag] },
    changed: true,
  };
}

/**
 * Scan a files map for legacy lat/lng entries, rewrite each migrated entry,
 * and persist back to wsd.json if anything changed. No-op when the data is
 * already in the tag-only format.
 */
async function migrateLatLngInPlace(
  dirPath: string,
  files: Record<string, SidecarMeta>
): Promise<Record<string, SidecarMeta>> {
  let changed = false;
  const next: Record<string, SidecarMeta> = {};
  for (const [name, meta] of Object.entries(files)) {
    const { next: migrated, changed: c } = migrateLatLngToTag(meta as LegacySidecarMeta);
    next[name] = migrated;
    if (c) changed = true;
  }
  if (!changed) return files;
  await withLock(dirPath, async () => {
    // Re-read inside the lock so we don't clobber a concurrent write.
    const fresh = await loadWsd(dirPath);
    if (!fresh?.files) return;
    const merged: Record<string, SidecarMeta> = { ...fresh.files };
    for (const [name, meta] of Object.entries(next)) {
      const { next: m2 } = migrateLatLngToTag(merged[name] as LegacySidecarMeta);
      merged[name] = m2;
    }
    await persistWsd(dirPath, merged);
  });
  return next;
}

/** True when a sidecar carries no useful data (omit it to keep the store sparse). */
function isSidecarEmpty(meta: SidecarMeta): boolean {
  return (
    (!meta.tags || meta.tags.length === 0) &&
    !meta.color &&
    !meta.description &&
    !meta.created &&
    !meta.modified
  );
}

/**
 * Writes (or removes) a directory's wsd.json from a full files map. An empty
 * map deletes the file so an all-untagged directory leaves no trace behind.
 */
async function persistWsd(
  dirPath: string,
  files: Record<string, SidecarMeta>
): Promise<void> {
  const target = wsdPath(dirPath);
  if (Object.keys(files).length === 0) {
    await fsp.rm(target, { force: true }).catch(() => undefined);
    return;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJson(target, { version: SIDECAR_VERSION, files });
}

/**
 * One-time legacy migration: folds any old per-file `<file>.json` sidecars in
 * this directory into wsd.json and deletes the originals. Returns the merged
 * files map (empty if there was nothing to migrate). The caller MUST hold the
 * directory lock — this does read-modify-write on disk.
 */
async function migrateLegacySidecars(
  dirPath: string
): Promise<Record<string, SidecarMeta>> {
  const metaDir = path.join(dirPath, META_DIR);
  let names: string[];
  try {
    names = await fsp.readdir(metaDir);
  } catch {
    return {}; // no .whale/ yet
  }
  // Old sidecars were `<basename>.json`; skip the reserved index/meta files and
  // anything that isn't `.json` (e.g. wsft.jsonl, thumbnails).
  const legacy = names.filter(
    (n) => n.endsWith('.json') && !RESERVED_META_FILES.has(n)
  );
  if (legacy.length === 0) return {};

  const files: Record<string, SidecarMeta> = {};
  for (const n of legacy) {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(metaDir, n), 'utf8'));
      if (parsed && typeof parsed === 'object') {
        // `<basename>.json` → strip the trailing `.json` to recover the file name.
        const baseName = n.slice(0, -'.json'.length);
        const meta = parsed as SidecarMeta;
        if (!isSidecarEmpty(meta)) files[baseName] = meta;
      }
    } catch {
      // corrupt legacy sidecar — skip it
    }
  }

  // Persist the merged map (if non-empty), then remove the legacy files either
  // way so the migration doesn't re-run on the next access.
  await persistWsd(dirPath, files);
  await Promise.all(
    legacy.map((n) =>
      fsp.rm(path.join(metaDir, n), { force: true }).catch(() => undefined)
    )
  );
  return files;
}

/**
 * Loads a directory's files map, migrating legacy per-file sidecars on the
 * first miss. The caller MUST hold the directory lock whenever wsd.json may be
 * absent (i.e. the migration path can run).
 */
async function loadFilesOrMigrate(
  dirPath: string
): Promise<Record<string, SidecarMeta>> {
  const wsd = await loadWsd(dirPath);
  if (wsd?.files) return wsd.files;
  return migrateLegacySidecars(dirPath);
}

/** Reads a file's sidecar; null if the file has none. Triggers migration on miss. */
export async function readSidecar(
  filePath: string
): Promise<SidecarMeta | null> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  // Fast path: wsd.json present → single lock-free read.
  const wsd = await loadWsd(dir);
  if (wsd?.files) {
    // Run the same lat/lng → tag migration as `readSidecars` so callers get
    // consistent data regardless of which entry point they use.
    const migrated = await migrateLatLngInPlace(dir, wsd.files);
    return migrated[name] ?? null;
  }
  // Slow path: legacy per-file sidecars may need migrating — under lock.
  const files = await withLock(dir, () => loadFilesOrMigrate(dir));
  return files[name] ?? null;
}

/** Reads sidecars for many files in one directory; returns name -> meta. */
export async function readSidecars(
  dirPath: string,
  names: string[]
): Promise<Record<string, SidecarMeta>> {
  // Fast path: a single read, filter in memory.
  const wsd = await loadWsd(dirPath);
  let files = wsd?.files ?? null;
  if (!files) {
    // Slow path: migrate under lock (double-checks wsd.json inside).
    files = await withLock(dirPath, () => loadFilesOrMigrate(dirPath));
  }
  // One-shot legacy lat/lng → geo:lat,lng tag migration. Idempotent: a
  // re-read after migration is a no-op. Triggered here so any consumer of
  // `readSidecars` (renderer, IPC, tests) automatically gets migrated data
  // without needing to know about the old schema.
  files = await migrateLatLngInPlace(dirPath, files);
  const result: Record<string, SidecarMeta> = {};
  for (const name of names) {
    const meta = files[name];
    if (meta) result[name] = meta;
  }
  return result;
}

/**
 * Reads sidecars for an arbitrary set of file paths (potentially across
 * multiple directories) in a single round trip. Returns `path -> meta`
 * where the key is the full input path and missing entries are omitted.
 *
 * The H.24 recursive scan (`DirectoryContentContextProvider`, depth > 1)
 * previously called `readSidecards(dir, names)` once per parent directory
 * via `ipcApi.readSidecards`, which cost 50+ IPCs for a 50-subdir scan.
 * This new function groups the inputs by parent, then delegates to the
 * existing per-directory fast path so the wsd.json-read amortization is
 * preserved while collapsing 50 IPCs into 1.
 *
 * **Two-pass fallback for subdirs without wsd.json**: Whale's aggregated
 * `wsd.json` is created lazily when a tag is first written to a file
 * in that directory. A freshly-scanned subdir usually has no wsd.json
 * yet, even though its files may carry *legacy* per-file sidecars
 * (`.whale/<file>.json` from older code paths). The bulk `readSidecards`
 * only reads wsd.json, so it would silently miss every legacy sidecar
 * in a never-tagged subdir. To make H.24's tag library + property tray
 * honest for those users, this function falls back to the per-file
 * `readSidecar` for any name that the wsd.json read returned no entry
 * for. Per-file reads are guarded by the existing `withLock` so the
 * migration from legacy -> aggregated is safe under concurrent writes.
 *
 * Empty / unknown paths are skipped silently -- they correspond to files
 * that no longer exist on disk between `listDirectoryRecursive` and the
 * sidecar read.
 */
export async function readSidecardsForPaths(
  filePaths: readonly string[]
): Promise<Record<string, SidecarMeta>> {
  if (filePaths.length === 0) return {};

  // Pass 1: group by parent directory and bulk-read wsd.json.
  // Read each directory in parallel -- `readSidecars` is internally
  // concurrency-safe (its per-dir lock only blocks writes to the same
  // `.whale/wsd.json`). For 50 subdirs this turns a 50-IPC sequential
  // scan into 1 IPC.
  const byDir = new Map<string, string[]>();
  for (const fp of filePaths) {
    if (!fp) continue;
    const dir = path.dirname(fp);
    const name = path.basename(fp);
    let bucket = byDir.get(dir);
    if (!bucket) {
      bucket = [];
      byDir.set(dir, bucket);
    }
    bucket.push(name);
  }
  const dirEntries = Array.from(byDir.entries());
  const perDir = await Promise.all(
    dirEntries.map(([dir, names]) => readSidecars(dir, names))
  );

  // Stitch back to the input paths by name -> result lookup. We can't
  // reuse `readSidecards`'s `name -> meta` shape directly because two
  // different paths can share a basename (e.g. `a/notes.md` and
  // `b/notes.md`), so we walk the original `filePaths` list and look
  // up each name in its dir's result.
  const dirIndex = new Map<string, number>();
  dirEntries.forEach(([dir], i) => dirIndex.set(dir, i));
  const out: Record<string, SidecarMeta> = {};
  // Track which paths the wsd.json read did NOT cover so we can fall
  // back to the per-file legacy path.
  const missing: string[] = [];
  for (const fp of filePaths) {
    if (!fp) continue;
    const dir = path.dirname(fp);
    const name = path.basename(fp);
    const idx = dirIndex.get(dir);
    if (idx === undefined) continue;
    const meta = perDir[idx][name];
    if (meta) out[fp] = meta;
    else missing.push(fp);
  }

  // Pass 2: per-file legacy fallback for paths the aggregated wsd.json
  // didn't cover. Mostly relevant for never-tagged subdirs whose only
  // sidecar format is the legacy per-file `.whale/<name>.json`.
  if (missing.length > 0) {
    const perFile = await Promise.all(missing.map((fp) => readSidecar(fp)));
    for (let i = 0; i < missing.length; i++) {
      const meta = perFile[i];
      if (meta) out[missing[i]] = meta;
    }
  }

  return out;
}

/** Writes a file's sidecar (creates `.whale/` if needed). Empty meta removes the entry. */
export async function writeSidecar(
  filePath: string,
  meta: SidecarMeta
): Promise<void> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  await withLock(dir, async () => {
    const files = await loadFilesOrMigrate(dir);
    const next = { ...files };
    if (isSidecarEmpty(meta)) {
      delete next[name];
    } else {
      next[name] = meta;
    }
    await persistWsd(dir, next);
  });
}

/**
 * Atomically read-modify-write a single file's tag array, preserving any
 * existing `color` / `description` / `created` / `modified` fields. The
 * `mutator` receives the current tag list (empty if the file has no sidecar
 * yet) and returns the desired next tag list. Everything runs under the
 * directory lock so a concurrent UI write to another file in the same
 * directory can't be clobbered.
 *
 * The pure-tag helper this exposes — used by the HTTP AI provider's
 * `apply_tag` tool, which needs removal/add operations to be merge-safe
 * against the user's interactive writes. The mutator is responsible for
 * smart-tag normalization (see `shared/smart-tags.ts:normalizeSmartTags`); this
 * function does not enforce it, to stay tag-shape-agnostic.
 */
export async function updateFileTags(
  filePath: string,
  mutator: (currentTags: string[]) => string[]
): Promise<{ before: string[]; after: string[] }> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  return withLock(dir, async () => {
    const files = await loadFilesOrMigrate(dir);
    const before = (files[name]?.tags ?? []).filter(
      (t): t is string => typeof t === 'string'
    );
    const after = mutator(before);
    // Cheap dedupe + type guard, preserving caller order.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of after) {
      if (typeof t === 'string' && !seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    const next = { ...files };
    const existing = files[name];
    if (deduped.length === 0 && (!existing || isSidecarEmpty(existing))) {
      delete next[name];
    } else {
      next[name] = {
        ...existing,
        tags: deduped,
      };
      // If tags are the only populated field and they're now empty, drop the
      // entry so an untagged file leaves the sparse store sparse.
      if (isSidecarEmpty(next[name])) delete next[name];
    }
    await persistWsd(dir, next);
    return { before, after: deduped };
  });
}

/**
 * Removes a file's sidecar entry (used when the file itself is deleted). No-op
 * if the file had none; also clears a stray legacy per-file file if one lingers.
 */
export async function removeSidecar(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  await withLock(dir, async () => {
    const wsd = await loadWsd(dir);
    if (!wsd?.files || !(name in wsd.files)) {
      await fsp
        .rm(legacySidecarPath(filePath), { force: true })
        .catch(() => undefined);
      return;
    }
    const next = { ...wsd.files };
    delete next[name];
    await persistWsd(dir, next);
  });
}

/**
 * Moves a file's sidecar to follow a rename/move. No-op if the file had none.
 * A same-directory rename is one locked read-modify-write; a cross-directory
 * move drops the source entry under the source lock, then adds it under the
 * destination lock (best-effort, matching the IPC layer's non-critical sync).
 */
export async function moveSidecar(
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldDir = path.dirname(oldPath);
  const newDir = path.dirname(newPath);
  const oldName = path.basename(oldPath);
  const newName = path.basename(newPath);

  if (oldDir === newDir) {
    await withLock(oldDir, async () => {
      const wsd = await loadWsd(oldDir);
      if (!wsd?.files || !(oldName in wsd.files)) return;
      const meta = wsd.files[oldName];
      const next = { ...wsd.files };
      delete next[oldName];
      next[newName] = meta;
      await persistWsd(oldDir, next);
    });
    return;
  }

  // Cross-directory: lift the entry out of the source, then drop it into the
  // destination. Each step holds only one lock (no cross-dir deadlock risk).
  const meta = await withLock(oldDir, async () => {
    const wsd = await loadWsd(oldDir);
    if (!wsd?.files || !(oldName in wsd.files)) return null;
    const m = wsd.files[oldName];
    const next = { ...wsd.files };
    delete next[oldName];
    await persistWsd(oldDir, next);
    return m;
  });
  if (!meta) return;

  await withLock(newDir, async () => {
    const files = await loadFilesOrMigrate(newDir);
    await persistWsd(newDir, { ...files, [newName]: meta });
  });
}

/** Copies a file's sidecar alongside a file copy. No-op if the source had none. */
export async function copySidecar(
  sourcePath: string,
  destPath: string
): Promise<void> {
  const srcDir = path.dirname(sourcePath);
  const srcName = path.basename(sourcePath);
  const destDir = path.dirname(destPath);
  const destName = path.basename(destPath);

  const meta = await withLock(srcDir, async () => {
    const files = await loadFilesOrMigrate(srcDir);
    return files[srcName] ?? null;
  });
  if (!meta) return;

  await withLock(destDir, async () => {
    const files = await loadFilesOrMigrate(destDir);
    await persistWsd(destDir, { ...files, [destName]: meta });
  });
}
