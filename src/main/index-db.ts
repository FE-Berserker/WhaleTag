import path from 'path';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';

/** A better-sqlite3 db instance (the default export is class+namespace merged,
 *  so use InstanceType to name the instance type unambiguously). */
type DB = InstanceType<typeof Database>;

// P0-2: this module must only be required from the index utilityProcess
// worker (`src/main/index-worker.ts`). Loading it directly in the Electron
// main process would bring the SQLite cache back onto the main event loop,
// defeating the entire migration. The `parentPort` check is the most
// reliable signal: utilityProcess children get a `ParentPort` instance; the
// main process gets `null` (Electron's `NodeJS.Process.parentPort` is a
// `ParentPort` if this is a UtilityProcess, `null` otherwise). Use a truthy
// check so both `null` and a hypothetical `undefined` are caught.
//
// Gated on NODE_ENV === 'production' so unit tests (which import this
// module directly via ts-node) and dev mode both still work. In a packaged
// build, webpack replaces `process.env.NODE_ENV` with the literal string
// `'production'`, so the check is always on in shipped binaries.
if (
  !process.parentPort &&
  process.env.NODE_ENV === 'production'
) {
  throw new Error(
    'index-db.ts must be required from the index utilityProcess worker ' +
      '("src/main/index-worker.ts"), not the Electron main process. ' +
      'Use `request()` from "./index-worker-host" instead of importing ' +
      'this module directly.'
  );
}
import { META_DIR } from '../shared/whale-meta';
import type { IndexEntry, FulltextHit } from '../shared/ipc-types';
import type { SearchQuery } from '../shared/search-query';

/**
 * Per-root SQLite search index at `<root>/.whale/index.db`. Replaces the old
 * `wsi.json` (files table + `files_fts`) and `wsft.jsonl` (`fulltext_fts`).
 *
 * FTS5 with the **trigram** tokenizer gives substring + near-fuzzy filename/
 * tag matching in O(matches) instead of the old O(N) Fuse.js scan; structured
 * filters (ext/size/mtime/tags) run as SQL `WHERE`. Both are far faster than
 * the JSON/JSONL line-scan they replace and need no full in-memory load. See
 * plan §6.6 P2.
 *
 * `better-sqlite3` is synchronous; all of this runs on the main thread inside
 * short transactions. DB handles are cached per root (open once, reused).
 */

const INDEX_DB_FILE = 'index.db';
const QUERY_LIMIT = 50;
const ADV_LIMIT = 300;
/**
 * Rows committed per ingest transaction. Each batch is one short synchronous
 * transaction; `ingestFiles`/`ingestFulltext` yield to the event loop between
 * batches so a 100k-file rebuild doesn't freeze the Electron main process
 * (every window, every IPC) inside one giant transaction.
 */
const INGEST_BATCH = 1000;

function dbPath(rootPath: string): string {
  return path.join(rootPath, META_DIR, INDEX_DB_FILE);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_dir INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    ext TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT ''
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    name, path, tags, content='files', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name, path, tags)
      VALUES (new.rowid, new.name, new.path, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, path, tags)
      VALUES ('delete', old.rowid, old.name, old.path, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, path, tags)
      VALUES ('delete', old.rowid, old.name, old.path, old.tags);
    INSERT INTO files_fts(rowid, name, path, tags)
      VALUES (new.rowid, new.name, new.path, new.tags);
  END;
  CREATE VIRTUAL TABLE IF NOT EXISTS fulltext_fts USING fts5(
    path, name, mtime UNINDEXED, content
  );
  -- P3-4: cache of EXIF GPS extraction results so reopening a directory
  -- doesn't re-decode every image. Keyed by absolute path. status is "ok"
  -- (file has GPS) or "none" (no GPS data, definitively — i.e. a
  -- re-extraction attempt would not yield a different result). tried_at
  -- is a millisecond epoch for LRU eviction / debugging; not consulted
  -- by the read path (MVP trusts the cache until the user clicks refresh).
  CREATE TABLE IF NOT EXISTS exif_processed (
    path TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('ok', 'none')),
    lat REAL,
    lng REAL,
    tried_at INTEGER NOT NULL
  );
  -- P2-2: per-root derived counters so the readiness poll (indexStatus) is
  -- O(1) instead of a SELECT count(*) full scan on a large index. Only
  -- files_count is maintained today (set to the walked entry count at the
  -- end of every ingest); other keys are reserved.
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

interface FileRow {
  path: string;
  name: string;
  is_dir: number;
  size: number;
  mtime: number;
  ext: string;
  tags: string;
}

interface FulltextRecord {
  /** Path relative to root, '/'-separated (portable). */
  path: string;
  name: string;
  mtime: number;
  content: string;
}

const openDbs = new Map<string, DB>();

/** Opens (creating if needed) and caches the index db for `rootPath`. */
function getDb(rootPath: string): DB {
  let db = openDbs.get(rootPath);
  if (!db) {
    db = new Database(dbPath(rootPath));
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    openDbs.set(rootPath, db);
  }
  return db;
}

/** Closes one root's db (e.g. when its location is removed). */
export function closeDb(rootPath: string): void {
  const db = openDbs.get(rootPath);
  if (db) {
    db.close();
    openDbs.delete(rootPath);
  }
}

/** Closes every open db (call on app shutdown). */
export function closeAllDbs(): void {
  for (const db of openDbs.values()) db.close();
  openDbs.clear();
}

// P2-3: prepared-statement cache. Compiling a statement (`db.prepare`) walks
// SQLite's parser/planner; doing it on every keystroke of an as-you-type
// search is pure waste. Statements are connection-bound, so the cache is
// keyed by DB instance (WeakMap → entries are reclaimed automatically when a
// closed db is GC'd, and a reopened db gets a fresh cache with no stale
// statements). `advancedQuery` builds its SQL per filter shape, but the same
// shape repeats across keystrokes → the cache hits on everything but the
// param values (which are bound at `.all()` time, not prepare time).
type PreparedStatement = Database.Statement<unknown[], unknown>;
const stmtCache = new WeakMap<DB, Map<string, PreparedStatement>>();

/** Returns a cached `Statement` for `sql` on `db`, preparing it on first use. */
function prepareCached(db: DB, sql: string): PreparedStatement {
  let bySql = stmtCache.get(db);
  if (!bySql) {
    bySql = new Map();
    stmtCache.set(db, bySql);
  }
  let stmt = bySql.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    bySql.set(sql, stmt);
  }
  return stmt;
}

// P2-2: O(1) file count via `meta.files_count` (maintained at the end of every
// `ingestFiles`). For dbs created before this counter existed, fall back to a
// one-time `count(*)` and cache the result so subsequent readiness polls are
// O(1) — the expensive scan runs at most once per root, ever.
function getFileCount(db: DB): number {
  const row = prepareCached(db, "SELECT value FROM meta WHERE key = 'files_count'").get() as
    | { value: number }
    | undefined;
  if (row !== undefined) return row.value;
  const r = prepareCached(db, 'SELECT count(*) AS c FROM files').get() as { c: number };
  prepareCached(
    db,
    `INSERT INTO meta(key, value) VALUES('files_count', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(r.c);
  return r.c;
}

function rowToEntry(r: FileRow): IndexEntry {
  return {
    path: r.path,
    name: r.name,
    isDir: r.is_dir === 1,
    size: r.size,
    mtime: r.mtime,
    ext: r.ext,
    tags: r.tags ? r.tags.split(' ').filter(Boolean) : [],
  };
}

/** Wraps a query string as an FTS5 phrase (matches a contiguous substring). */
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/** Escapes `%`/`_`/`\` for a LIKE pattern used with `ESCAPE '\'`. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Returns control to the event loop so other IPC / UI work can run. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Signature capturing every field of a files row that can change between
 *  walks. `mtime` + `size` cover file modifications; `tags` come from sidecars
 *  and can change WITHOUT an mtime bump (indexer.ts relies on exactly this), so
 *  tags MUST be in the signature or a tag edit wouldn't re-index. `name`/`ext`
 *  are derived from the path (stable per path); `is_dir` is stable per path.
 *  See docs/15 P0-1. */
function filesSignature(e: IndexEntry): string {
  return `${e.mtime}|${e.size}|${(e.tags ?? []).join(' ')}`;
}

/** Existing files rows as Map<path, signature> — the "prior" state ingestFiles
 *  compares against to skip unchanged upserts. Mirrors `fulltextPrior`. Returns
 *  an empty map when the db doesn't exist yet (first index of this root). */
export function filesPrior(rootPath: string): Map<string, string> {
  if (!existsSync(dbPath(rootPath))) return new Map();
  const rows = getDb(rootPath).prepare(
    'SELECT path, mtime, size, tags FROM files'
  ).all() as { path: string; mtime: number; size: number; tags: string }[];
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.path, `${r.mtime}|${r.size}|${r.tags}`);
  return m;
}

/**
 * Incrementally upserts `entries` (the full current set for the root) into the
 * files index, and deletes any file no longer present. FTS stays in sync via
 * the triggers.
 *
 * Incremental (docs/15 P0-1): rows whose signature (`mtime|size|tags`) is
 * unchanged since the last build are skipped entirely. `ON CONFLICT DO UPDATE`
 * always runs the UPDATE branch — which fires the `files_au` trigger (an FTS
 * delete+insert) — even for byte-identical rows, so a no-op re-index of a
 * 100k-file root used to pay 100k FTS delete+inserts. Now only changed/new rows
 * are upserted and only removed rows are deleted (mirrors the fulltext side's
 * `fulltextPrior` skip). `cur_paths` temp table is gone — `seen` is tracked in
 * JS and `removed` = prior paths not walked this run.
 *
 * The work is split into `INGEST_BATCH`-sized transactions with an event-loop
 * yield between each, so the synchronous better-sqlite3 calls never block the
 * worker for long. A 100k-file rebuild becomes many sub-10ms hiccups instead of
 * one multi-second freeze. The index is a rebuildable cache, so the loss of
 * single-transaction atomicity is acceptable.
 */
export async function ingestFiles(
  rootPath: string,
  entries: IndexEntry[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const db = getDb(rootPath);
  const upsert = db.prepare(`
    INSERT INTO files (path, name, is_dir, size, mtime, ext, tags)
    VALUES (@path, @name, @is_dir, @size, @mtime, @ext, @tags)
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name, is_dir=excluded.is_dir, size=excluded.size,
      mtime=excluded.mtime, ext=excluded.ext, tags=excluded.tags
  `);

  const prior = filesPrior(rootPath);
  const seen = new Set<string>();
  const changed: IndexEntry[] = [];
  for (const e of entries) {
    seen.add(e.path);
    const prevSig = prior.get(e.path);
    if (prevSig !== undefined && prevSig === filesSignature(e)) continue;
    changed.push(e);
  }

  // Drop rows for files no longer on disk (in the db but not walked this run).
  const removed: string[] = [];
  for (const p of prior.keys()) if (!seen.has(p)) removed.push(p);

  // docs/04 §10 progress: one counter across the delete + upsert loops; the
  // worker throttles the events, so reporting every batch is fine.
  const total = removed.length + changed.length;
  let done = 0;

  const delStmt = db.prepare('DELETE FROM files WHERE path = ?');
  const delBatch = db.transaction((paths: string[]) => {
    for (const p of paths) delStmt.run(p);
  });
  for (let i = 0; i < removed.length; i += INGEST_BATCH) {
    delBatch(removed.slice(i, i + INGEST_BATCH));
    done += Math.min(INGEST_BATCH, removed.length - i);
    onProgress?.(done, total);
    await yieldToEventLoop();
  }

  const upsertBatch = db.transaction((rows: IndexEntry[]) => {
    for (const e of rows) {
      upsert.run({
        path: e.path,
        name: e.name,
        is_dir: e.isDir ? 1 : 0,
        size: e.size,
        mtime: e.mtime,
        ext: e.ext,
        tags: (e.tags ?? []).join(' '),
      });
    }
  });
  for (let i = 0; i < changed.length; i += INGEST_BATCH) {
    upsertBatch(changed.slice(i, i + INGEST_BATCH));
    done += Math.min(INGEST_BATCH, changed.length - i);
    onProgress?.(done, total);
    await yieldToEventLoop();
  }

  // P2-2: the files table now holds exactly `seen` (every current entry —
  // unchanged rows stay, changed/new are upserted, removed are deleted), so
  // cache that count for O(1) readiness polls. Self-healing: every ingest
  // rewrites it, so any drift is corrected on the next walk.
  prepareCached(
    db,
    `INSERT INTO meta(key, value) VALUES('files_count', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(seen.size);
}

/** Filename/path/tags fuzzy search via FTS5 trigram (>=3 chars) or LIKE (<3). */
export function queryFiles(rootPath: string, q: string): IndexEntry[] {
  const term = q.trim();
  if (!term) return [];
  const db = getDb(rootPath);
  let rows: FileRow[];
  if (term.length >= 3) {
    rows = prepareCached(
      db,
      `SELECT f.* FROM files_fts
         JOIN files f ON f.rowid = files_fts.rowid
         WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(ftsPhrase(term), QUERY_LIMIT) as FileRow[];
  } else {
    const like = `%${term}%`;
    rows = prepareCached(
      db,
      `SELECT * FROM files WHERE name LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
         ORDER BY is_dir DESC, name LIMIT ?`
    ).all(like, like, QUERY_LIMIT) as FileRow[];
  }
  return rows.map(rowToEntry);
}

/** Structured (advanced) search — the SearchQuery compiled to SQL WHERE. */
export function advancedQuery(rootPath: string, q: SearchQuery): IndexEntry[] {
  const db = getDb(rootPath);
  const where: string[] = [];
  const params: unknown[] = [];

  const text = q.text.trim();
  if (text) {
    if (text.length >= 3) {
      where.push('rowid IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)');
      params.push(ftsPhrase(text));
    } else {
      where.push('name LIKE ? ESCAPE "\\"');
      params.push(`%${escapeLike(text)}%`);
    }
  }
  if (q.type === 'files') where.push('is_dir = 0');
  if (q.type === 'folders') where.push('is_dir = 1');
  if (q.extensions.length > 0) {
    where.push(`ext IN (${q.extensions.map(() => '?').join(',')})`);
    params.push(...q.extensions);
  }
  if (q.sizeMinBytes !== null) {
    where.push('is_dir = 0 AND size >= ?');
    params.push(q.sizeMinBytes);
  }
  if (q.sizeMaxBytes !== null) {
    where.push('is_dir = 0 AND size <= ?');
    params.push(q.sizeMaxBytes);
  }
  if (q.modifiedAfter !== null) {
    where.push('mtime >= ?');
    params.push(q.modifiedAfter);
  }
  if (q.modifiedBefore !== null) {
    where.push('mtime <= ?');
    params.push(q.modifiedBefore);
  }
  if (q.tags.length > 0) {
    const cond = q.tags.map(() => `(' ' || tags || ' ') LIKE ? ESCAPE '\\'`);
    params.push(...q.tags.map((t) => `% ${escapeLike(t)} %`));
    where.push(`(${cond.join(q.tagMatch === 'all' ? ' AND ' : ' OR ')})`);
  }
  if (q.excludeTags.length > 0) {
    const cond = q.excludeTags.map(() => `(' ' || tags || ' ') LIKE ? ESCAPE '\\'`);
    params.push(...q.excludeTags.map((t) => `% ${escapeLike(t)} %`));
    where.push(`NOT (${cond.join(' OR ')})`);
  }

  const sql = `SELECT * FROM files ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_dir DESC, name LIMIT ?`;
  params.push(ADV_LIMIT);
  // P2-3: cache by the assembled SQL string. The same filter shape (same set
  // of active filters) produces identical SQL across keystrokes → cache hit;
  // only the param values differ, and those bind at .all() time.
  const rows = prepareCached(db, sql).all(...params) as FileRow[];
  return rows.map(rowToEntry);
}

/** All distinct tags across the index (for the advanced-search tag picker). */
export function distinctTags(rootPath: string): string[] {
  const db = getDb(rootPath);
  const rows = prepareCached(db, "SELECT tags FROM files WHERE tags != ''").all() as Pick<
    FileRow,
    'tags'
  >[];
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of r.tags.split(' ')) {
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Prior fulltext mtimes (path → mtime) for incremental rebuild.
 *  Only the mtime is needed to detect unchanged files; their content stays in
 *  the DB untouched and is NEVER loaded into JS memory. (Previously this
 *  selected `content` too, pulling every indexed document body — up to
 *  MAX_TEXT_PER_FILE each — into one synchronous Map, which froze the main
 *  process on large corpora.) */
export function fulltextPrior(rootPath: string): Map<string, number> {
  if (!existsSync(dbPath(rootPath))) return new Map();
  const db = getDb(rootPath);
  const rows = db
    .prepare('SELECT path, mtime FROM fulltext_fts')
    .all() as { path: string; mtime: number }[];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.path, r.mtime);
  return m;
}

/**
 * Batched INSERT of fulltext records (no delete). Split out of ingestFulltext
 * so the incremental rebuild can insert only changed/new records without
 * touching unchanged rows. Yields to the event loop between batches so a large
 * corpus doesn't freeze the main process.
 */
export async function insertFulltext(
  rootPath: string,
  records: FulltextRecord[]
): Promise<void> {
  if (records.length === 0) return;
  const db = getDb(rootPath);
  const ins = db.prepare(
    'INSERT INTO fulltext_fts(path, name, mtime, content) VALUES (?, ?, ?, ?)'
  );
  const insBatch = db.transaction((recs: FulltextRecord[]) => {
    for (const r of recs) ins.run(r.path, r.name, r.mtime, r.content);
  });
  for (let i = 0; i < records.length; i += INGEST_BATCH) {
    insBatch(records.slice(i, i + INGEST_BATCH));
    await yieldToEventLoop();
  }
}

/**
 * Batched DELETE of fulltext rows by path. Used by the incremental rebuild to
 * drop files removed from disk and stale rows for changed files. FTS5 supports
 * DELETE on a non-rowid column (verified empirically against better-sqlite3).
 */
export async function deleteFulltextPaths(
  rootPath: string,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;
  const db = getDb(rootPath);
  const del = db.prepare('DELETE FROM fulltext_fts WHERE path = ?');
  const delBatch = db.transaction((ps: string[]) => {
    for (const p of ps) del.run(p);
  });
  for (let i = 0; i < paths.length; i += INGEST_BATCH) {
    delBatch(paths.slice(i, i + INGEST_BATCH));
    await yieldToEventLoop();
  }
}

/**
 * Replaces the full-text index with `records` (full rebuild): DELETE all, then
 * batched INSERT. Retained for tests / standalone full-replace; the live
 * rebuild path (buildFulltextIndex) now uses insertFulltext +
 * deleteFulltextPaths so unchanged rows are never re-loaded into memory.
 */
export async function ingestFulltext(
  rootPath: string,
  records: FulltextRecord[]
): Promise<void> {
  const db = getDb(rootPath);
  db.exec('DELETE FROM fulltext_fts');
  await insertFulltext(rootPath, records);
}

/**
 * Full-text search: returns hits with a snippet excerpt. Hit paths are absolute
 * (root + the stored relative path).
 */
export function queryFulltext(rootPath: string, q: string): FulltextHit[] {
  const term = q.trim();
  if (term.length < 3) return []; // trigram needs >= 3 chars
  const db = getDb(rootPath);
  const rows = prepareCached(
    db,
    `SELECT path, name,
         snippet(fulltext_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet
       FROM fulltext_fts WHERE fulltext_fts MATCH ?
       ORDER BY rank LIMIT 100`
  ).all(ftsPhrase(term)) as { path: string; name: string; snippet: string }[];
  return rows.map((r) => ({
    path: path.join(rootPath, ...r.path.split('/')),
    name: r.name,
    snippet: r.snippet,
  }));
}

/** True if the root has any full-text content indexed. O(1)-ish: stops at the
 *  first row instead of a `count(*)` over every fulltext segment. */
export function hasFulltext(rootPath: string): boolean {
  if (!existsSync(dbPath(rootPath))) return false;
  const db = getDb(rootPath);
  const row = prepareCached(db, 'SELECT 1 FROM fulltext_fts LIMIT 1').get();
  return row !== undefined;
}

/** Index status: how many files are indexed, and whether one exists at all.
 *  O(1) via `meta.files_count` (see `getFileCount`). */
export function indexStatus(rootPath: string): { count: number; ready: boolean } {
  if (!existsSync(dbPath(rootPath))) return { count: 0, ready: false };
  const db = getDb(rootPath);
  const count = getFileCount(db);
  return { count, ready: count > 0 };
}

/** Best-effort removal of the legacy wsi.json (now superseded by index.db). */
export function removeLegacyWsi(rootPath: string): void {
  const { rmSync } = require('fs');
  try {
    rmSync(path.join(rootPath, META_DIR, 'wsi.json'), { force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// P3-4: EXIF GPS extraction cache. Persists "we already tried this file"
// results so reopening a directory doesn't re-decode every image.
// ---------------------------------------------------------------------------

/** One cached EXIF GPS extraction result. */
export interface ExifProcessedRecord {
  path: string;
  /** 'ok' = file has GPS; 'none' = no GPS data (definitively). */
  status: 'ok' | 'none';
  /** Populated only when status === 'ok'. */
  lat: number | null;
  lng: number | null;
  /** Millisecond epoch when the result was recorded. */
  triedAt: number;
}

interface ExifProcessedRow {
  path: string;
  status: string;
  lat: number | null;
  lng: number | null;
  tried_at: number;
}

function rowToExifRecord(r: ExifProcessedRow): ExifProcessedRecord {
  return {
    path: r.path,
    status: r.status === 'ok' ? 'ok' : 'none',
    lat: r.lat,
    lng: r.lng,
    triedAt: r.tried_at,
  };
}

/** Load all cached EXIF records for the given root. Returns `[]` when the
 *  db doesn't exist yet (the table is created lazily on first open). */
export function loadExifProcessed(rootPath: string): ExifProcessedRecord[] {
  if (!existsSync(dbPath(rootPath))) return [];
  const db = getDb(rootPath);
  const rows = db
    .prepare(
      'SELECT path, status, lat, lng, tried_at FROM exif_processed'
    )
    .all() as ExifProcessedRow[];
  return rows.map(rowToExifRecord);
}

/** Upsert a single EXIF extraction result. Idempotent: re-marking with the
 *  same path overwrites the prior record (tried_at updates). */
export function markExifProcessed(
  rootPath: string,
  record: ExifProcessedRecord
): void {
  const db = getDb(rootPath);
  db.prepare(
    `INSERT INTO exif_processed (path, status, lat, lng, tried_at)
     VALUES (@path, @status, @lat, @lng, @tried_at)
     ON CONFLICT(path) DO UPDATE SET
       status=excluded.status,
       lat=excluded.lat,
       lng=excluded.lng,
       tried_at=excluded.tried_at`
  ).run({
    path: record.path,
    status: record.status,
    lat: record.lat,
    lng: record.lng,
    tried_at: record.triedAt,
  });
}

/** Upsert MANY EXIF results in ONE transaction (one WAL fsync) instead of one
 *  per row. The Mapique batch extractor processes a folder of N photos; without
 *  this it fired N separate IPCs → N autocommit transactions → N fsyncs on the
 *  main thread. Empty input is a no-op. */
export function markExifProcessedMany(
  rootPath: string,
  records: readonly ExifProcessedRecord[]
): void {
  if (records.length === 0) return;
  const db = getDb(rootPath);
  const stmt = db.prepare(
    `INSERT INTO exif_processed (path, status, lat, lng, tried_at)
     VALUES (@path, @status, @lat, @lng, @tried_at)
     ON CONFLICT(path) DO UPDATE SET
       status=excluded.status,
       lat=excluded.lat,
       lng=excluded.lng,
       tried_at=excluded.tried_at`
  );
  const insertMany = db.transaction((recs: readonly ExifProcessedRecord[]) => {
    for (const r of recs) {
      stmt.run({
        path: r.path,
        status: r.status,
        lat: r.lat,
        lng: r.lng,
        tried_at: r.triedAt,
      });
    }
  });
  insertMany(records);
}

/** Wipe the EXIF cache for `rootPath`. Used by the "Refresh EXIF" button to
 *  force a full re-extraction. */
export function clearExifProcessed(rootPath: string): void {
  if (!existsSync(dbPath(rootPath))) return;
  const db = getDb(rootPath);
  db.exec('DELETE FROM exif_processed');
}
