import path from 'path';
import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import {
  META_DIR,
  FOLDER_SIDECAR_FILE,
  FOLDER_META_FILE,
  FOLDER_INDEX_FILE,
  FOLDER_FULLTEXT_FILE,
  MIGRATION_STATE_FILE,
  SIDECAR_VERSION,
  type SidecarMeta,
  type AggregatedSidecar,
} from '../shared/whale-meta';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';
import { mapWithConcurrency } from './concurrency';
import { assertWithinAllowedRoot } from './allowed-roots';
import type {
  RecoverCorruptSidecarRequest,
  RecoverCorruptSidecarResult,
  SidecarIssue,
  SidecarReadResult,
} from '../shared/ipc-types';

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
  // Migration flags only look like a legacy sidecar. Without this entry the
  // reader folded it into wsd.json and deleted it, so the flag was cleared on
  // every start and the migration re-ran (and re-backed-up) forever.
  MIGRATION_STATE_FILE,
]);

/** Path of a directory's aggregated sidecar file. */
function wsdPath(dirPath: string): string {
  return path.join(dirPath, META_DIR, FOLDER_SIDECAR_FILE);
}

/** Legacy per-file sidecar path (`<dir>/.whale/<file>.json`) — migration only. */
function legacySidecarPath(filePath: string): string {
  return path.join(path.dirname(filePath), META_DIR, `${path.basename(filePath)}.json`);
}

type SidecarReadError = Error & { sidecarIssue?: SidecarIssue };

function attachSidecarIssue<T extends Error>(error: T, issue: SidecarIssue): T {
  (error as SidecarReadError).sidecarIssue = issue;
  return error;
}

function sidecarIssueFromError(error: unknown): SidecarIssue | null {
  return error instanceof Error
    ? ((error as SidecarReadError).sidecarIssue ?? null)
    : null;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes.toString('latin1'), 'latin1').digest('hex');
}

function corruptIssue(
  dirPath: string,
  bytes: Buffer,
  reason: 'invalid-json' | 'invalid-shape'
): SidecarIssue {
  return {
    kind: 'corrupt',
    reason,
    dirPath,
    sidecarPath: wsdPath(dirPath),
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

/** Parse one captured byte snapshot; all errors retain structured read details. */
function parseWsdBytes(dirPath: string, bytes: Buffer | null): AggregatedSidecar | null {
  // A crash/truncation can leave a zero-byte file. It contains no metadata to
  // preserve, so allow the normal migration/write path to rebuild it.
  if (!bytes || bytes.toString('utf8').trim() === '') return null;
  let parsed: {
    version?: unknown;
    files?: unknown;
  };
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as {
      version?: unknown;
      files?: unknown;
    };
  } catch (error) {
    throw attachSidecarIssue(
      error as Error,
      corruptIssue(dirPath, bytes, 'invalid-json')
    );
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed.files &&
    typeof parsed.files === 'object' &&
    !Array.isArray(parsed.files)
  ) {
    return {
      version: typeof parsed.version === 'number' ? parsed.version : SIDECAR_VERSION,
      files: parsed.files as Record<string, SidecarMeta>,
    };
  }
  throw attachSidecarIssue(
    new Error(`Invalid aggregated sidecar format: ${wsdPath(dirPath)}`),
    corruptIssue(dirPath, bytes, 'invalid-shape')
  );
}

/** Read the exact on-disk bytes; ENOENT is the only non-error read failure. */
async function readWsdBytes(dirPath: string): Promise<Buffer | null> {
  const target = wsdPath(dirPath);
  try {
    return await fsp.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw attachSidecarIssue(error as Error, {
      kind: 'unreadable',
      reason: 'io',
      dirPath,
      sidecarPath: target,
    });
  }
}

/** Missing or blank wsd.json is empty; malformed or unreadable data throws. */
async function loadWsd(dirPath: string): Promise<AggregatedSidecar | null> {
  return parseWsdBytes(dirPath, await readWsdBytes(dirPath));
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
  return withLock(dirPath, async () => {
    // Re-read inside the lock and migrate the current map, not the stale keys
    // from the lock-free snapshot: a concurrent write may add/remove entries.
    const fresh = await loadWsd(dirPath);
    if (!fresh?.files) return {};
    const merged: Record<string, SidecarMeta> = { ...fresh.files };
    for (const name of Object.keys(merged)) {
      const { next: migrated } = migrateLatLngToTag(merged[name] as LegacySidecarMeta);
      merged[name] = migrated;
    }
    await persistWsd(dirPath, merged);
    return merged;
  });
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
 * map normally deletes the file; a recovered directory with retained legacy
 * sidecars keeps an empty aggregate so deleting its last tag cannot resurrect
 * the legacy entries on the next read.
 */
async function persistWsd(
  dirPath: string,
  files: Record<string, SidecarMeta>
): Promise<void> {
  const target = wsdPath(dirPath);
  if (Object.keys(files).length === 0) {
    const legacy = await readLegacySidecars(dirPath);
    if (legacy.paths.length === 0) {
      await fsp.rm(target, { force: true });
      return;
    }
    // Recovery deliberately preserves legacy files. Keep the empty aggregate
    // as a tombstone instead of letting loadFilesOrMigrate import them again.
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteJson(target, { version: SIDECAR_VERSION, files: {} });
    return;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJson(target, { version: SIDECAR_VERSION, files });
}

interface LegacySidecarSnapshot {
  files: Record<string, SidecarMeta>;
  /** Legacy files that parsed — safe to fold in and then remove. */
  paths: string[];
  /** Legacy files that are NOT valid JSON — preserved (renamed), never dropped. */
  corrupt: string[];
}

/** Read legacy sidecars without changing them; IO errors abort the caller. */
async function readLegacySidecars(dirPath: string): Promise<LegacySidecarSnapshot> {
  const metaDir = path.join(dirPath, META_DIR);
  let names: string[];
  try {
    names = await fsp.readdir(metaDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { files: {}, paths: [], corrupt: [] };
    }
    throw error;
  }
  // Old sidecars were `<basename>.json`; skip the reserved index/meta files and
  // anything that isn't `.json` (e.g. wsft.jsonl, thumbnails).
  const paths = names
    .filter((n) => n.endsWith('.json') && !RESERVED_META_FILES.has(n))
    .map((n) => path.join(metaDir, n));
  const files: Record<string, SidecarMeta> = {};
  const parsedPaths: string[] = [];
  const corruptPaths: string[] = [];
  for (const filePath of paths) {
    // Read errors must abort a recovery/migration rather than hiding metadata
    // behind a newly-written aggregate.
    const raw = await fsp.readFile(filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Do NOT drop it: a malformed legacy sidecar still holds the only copy of
      // that file's tags. The caller preserves these (renamed out of the way).
      corruptPaths.push(filePath);
      continue;
    }
    if (parsed && typeof parsed === 'object') {
      const baseName = path.basename(filePath).slice(0, -'.json'.length);
      const meta = parsed as SidecarMeta;
      if (!isSidecarEmpty(meta)) files[baseName] = meta;
      parsedPaths.push(filePath);
    } else {
      // Valid JSON but not an object: unusable, but keep the bytes anyway.
      corruptPaths.push(filePath);
    }
  }
  return { files, paths: parsedPaths, corrupt: corruptPaths };
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
  const legacy = await readLegacySidecars(dirPath);
  if (legacy.paths.length === 0 && legacy.corrupt.length === 0) {
    return legacy.files;
  }

  // Persist the merged map (if non-empty), then remove ONLY the legacy files
  // that actually parsed. A malformed legacy sidecar is the only copy of that
  // file's tags: rename it out of the `.json` namespace so the migration never
  // re-runs, but keep the bytes recoverable.
  await persistWsd(dirPath, legacy.files);
  await Promise.all(
    legacy.paths.map((filePath) =>
      fsp.rm(filePath, { force: true }).catch(() => undefined)
    )
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await Promise.all(
    legacy.corrupt.map(async (filePath) => {
      try {
        await fsp.rename(filePath, `${filePath}.corrupt-${stamp}`);
        console.warn(
          `[sidecar] preserved malformed legacy sidecar as ${path.basename(filePath)}.corrupt-${stamp}`
        );
      } catch (error) {
        // Leave it in place: the next load retries (and never deletes it).
        console.warn(
          `[sidecar] could not preserve malformed legacy sidecar ${filePath}:`,
          error
        );
      }
    })
  );
  return legacy.files;
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

interface SidecarsCoreResult {
  result: SidecarReadResult;
  /** Original error retained solely for the legacy throwing wrapper. */
  error?: unknown;
}

async function readSidecarsCore(
  dirPath: string,
  names: string[]
): Promise<SidecarsCoreResult> {
  try {
    // Fast path: a single read, filter in memory.
    const wsd = await loadWsd(dirPath);
    let files = wsd?.files ?? null;
    if (!files) {
      // Slow path: migrate under lock (double-checks wsd.json inside).
      files = await withLock(dirPath, () => loadFilesOrMigrate(dirPath));
    }
    files = await migrateLatLngInPlace(dirPath, files);
    const sidecars: Record<string, SidecarMeta> = {};
    for (const name of names) {
      const meta = files[name];
      if (meta) sidecars[name] = meta;
    }
    return { result: { sidecars, issues: [] } };
  } catch (error) {
    const issue = sidecarIssueFromError(error);
    if (!issue) throw error;
    return { result: { sidecars: {}, issues: [issue] }, error };
  }
}

/** Detailed read: report corrupt/unreadable wsd.json without discarding healthy peers. */
export async function readSidecarsDetailed(
  dirPath: string,
  names: string[]
): Promise<SidecarReadResult> {
  return (await readSidecarsCore(dirPath, names)).result;
}

/** Compatibility wrapper: retain the original throwing read contract. */
export async function readSidecars(
  dirPath: string,
  names: string[]
): Promise<Record<string, SidecarMeta>> {
  const core = await readSidecarsCore(dirPath, names);
  if (core.error !== undefined) throw core.error;
  return core.result.sidecars;
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
export async function readSidecardsForPathsDetailed(
  filePaths: readonly string[]
): Promise<SidecarReadResult> {
  if (filePaths.length === 0) return { sidecars: {}, issues: [] };

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
  const perDir = await Promise.allSettled(
    dirEntries.map(([dir, names]) => readSidecarsDetailed(dir, names))
  );
  const issues: SidecarIssue[] = [];
  perDir.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(
        '[sidecar] Bulk read failed for one directory; preserving other results:',
        dirEntries[i][0],
        result.reason
      );
    } else {
      issues.push(...result.value.issues);
    }
  });

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
    const result = perDir[idx];
    // A corrupt/unreadable directory is reported once and is not retried once
    // per file; healthy directories still flow into the partial result.
    if (result.status === 'rejected') continue;
    if (result.value.issues.length > 0) continue;
    const meta = result.value.sidecars[name];
    if (meta) out[fp] = meta;
    else missing.push(fp);
  }

  // Pass 2: per-file legacy fallback for paths the aggregated wsd.json
  // didn't cover. Mostly relevant for never-tagged subdirs whose only
  // sidecar format is the legacy per-file `.whale/<name>.json`.
  if (missing.length > 0) {
    // Cap concurrency: a recursive view over thousands of untagged files used
    // to fan out one readSidecar per file at once (and each miss re-reads that
    // dir's wsd.json) — enough to exhaust the file-handle table (EMFILE) on
    // Windows. 8 matches the other batch file readers.
    const perFile = await mapWithConcurrency(missing, 8, async (fp) => {
      try {
        return { path: fp, meta: await readSidecar(fp), error: null as unknown };
      } catch (error) {
        return { path: fp, meta: null, error };
      }
    });
    for (const entry of perFile) {
      if (entry.meta) out[entry.path] = entry.meta;
      else if (entry.error) {
        console.error(
          '[sidecar] Legacy sidecar read failed:',
          entry.path,
          entry.error
        );
      }
    }
  }

  return { sidecars: out, issues };
}

/** Compatibility wrapper: recursive callers keep the original path -> meta shape. */
export async function readSidecardsForPaths(
  filePaths: readonly string[]
): Promise<Record<string, SidecarMeta>> {
  return (await readSidecardsForPathsDetailed(filePaths)).sidecars;
}

/** Write the captured bytes to a new exclusive backup and flush them before recovery. */
async function writeCorruptBackup(
  target: string,
  bytes: Buffer,
  digest: string
): Promise<string> {
  const stem = `${target}.corrupt-${Date.now()}-${digest.slice(0, 12)}`;
  for (let collision = 0; ; collision++) {
    const backupPath = `${stem}${collision === 0 ? '' : `-${collision}`}.bak`;
    assertWithinAllowedRoot(backupPath);
    let handle;
    try {
      handle = await fsp.open(backupPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      // Writing the captured snapshot (rather than copyFile) guarantees the
      // backup is byte-identical even if an external process touches the original.
      await handle.writeFile(bytes);
      await handle.datasync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(backupPath, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await handle.close();
    } catch (error) {
      await fsp.rm(backupPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return backupPath;
  }
}

/**
 * Explicit, user-confirmed recovery for one corrupt wsd.json. The original is
 * re-read and fingerprint-checked under the directory lock, backed up with an
 * exclusive create + datasync, then replaced atomically with a valid empty
 * aggregate. Readable legacy entries are retained in that aggregate without
 * modifying or deleting the legacy files, so recovery cannot hide old tags.
 */
export async function recoverCorruptSidecar({
  dirPath,
  expectedSha256,
}: RecoverCorruptSidecarRequest): Promise<RecoverCorruptSidecarResult> {
  const target = wsdPath(dirPath);
  assertWithinAllowedRoot(dirPath);
  assertWithinAllowedRoot(target);
  return withLock(dirPath, async () => {
    const bytes = await readWsdBytes(dirPath);
    // Valid, blank, and missing sidecars need no recovery. In particular this
    // makes a concurrent second confirmation a zero-write no-op.
    let healthy = true;
    try {
      parseWsdBytes(dirPath, bytes);
    } catch (error) {
      if (sidecarIssueFromError(error)?.kind !== 'corrupt') throw error;
      healthy = false;
    }
    if (healthy) return { status: 'not-corrupt' };
    if (!bytes) throw new Error('Corrupt sidecar classification requires captured bytes');

    const digest = sha256(bytes);
    if (digest !== expectedSha256) return { status: 'conflict' };
    const backupPath = await writeCorruptBackup(target, bytes, digest);
    // Merge readable legacy metadata into the valid aggregate without deleting
    // the legacy files. Leaving an empty aggregate here would otherwise hide
    // those old tags forever because loadFilesOrMigrate prefers any wsd.json.
    const legacy = await readLegacySidecars(dirPath);
    await atomicWriteJson(target, { version: SIDECAR_VERSION, files: legacy.files });
    return { status: 'recovered', backupPath };
  });
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
 * Atomically read-modify-write a single file's sidecar fields under the
 * directory lock — the whole-entry sibling of {@link updateFileTags}, used by
 * the MCP server's `whale_write_description` tool. `mutator` receives the
 * current meta (empty object if absent) and returns the next meta; returning
 * an empty meta drops the entry. Everything runs inside the lock so a
 * concurrent tag write to the same file can't be clobbered by a stale
 * read-snapshot (merge-over-wipe).
 */
export async function mutateSidecar(
  filePath: string,
  mutator: (current: SidecarMeta) => SidecarMeta
): Promise<SidecarMeta> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  return withLock(dir, async () => {
    const files = await loadFilesOrMigrate(dir);
    const before = files[name] ?? {};
    const after = mutator({ ...before });
    const next = { ...files };
    if (isSidecarEmpty(after)) {
      delete next[name];
    } else {
      next[name] = after;
    }
    await persistWsd(dir, next);
    return after;
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
 * The pure-tag helper this exposes — used by the MCP server's
 * `whale_apply_tags` tool, which needs removal/add operations to be merge-safe
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
