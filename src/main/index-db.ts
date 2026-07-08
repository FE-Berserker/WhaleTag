import path from 'path';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';

/** A better-sqlite3 db instance (the default export is class+namespace merged,
 *  so use InstanceType to name the instance type unambiguously). */
type DB = InstanceType<typeof Database>;
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

/**
 * Replaces the files index with `entries` (the full current set for the root):
 * upserts every entry and deletes any file no longer present. FTS stays in sync
 * via the triggers.
 *
 * The work is split into `INGEST_BATCH`-sized transactions with an event-loop
 * yield between each, so the synchronous better-sqlite3 calls never block the
 * main process for long. A 100k-file rebuild becomes many sub-10ms hiccups
 * (IPC/UI stay responsive) instead of one multi-second freeze. The index is a
 * rebuildable cache, so the loss of single-transaction atomicity is acceptable.
 */
export async function ingestFiles(
  rootPath: string,
  entries: IndexEntry[]
): Promise<void> {
  const db = getDb(rootPath);
  const upsert = db.prepare(`
    INSERT INTO files (path, name, is_dir, size, mtime, ext, tags)
    VALUES (@path, @name, @is_dir, @size, @mtime, @ext, @tags)
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name, is_dir=excluded.is_dir, size=excluded.size,
      mtime=excluded.mtime, ext=excluded.ext, tags=excluded.tags
  `);

  // Collect the surviving paths, then drop rows for files no longer on disk.
  // `cur_paths` is a TEMP table (per-connection); IF NOT EXISTS + a reset clear
  // make this safe even if a previous run left it behind after an error.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS cur_paths(path TEXT PRIMARY KEY)');
  db.exec('DELETE FROM cur_paths');
  const insCur = db.prepare('INSERT OR IGNORE INTO cur_paths(path) VALUES (?)');
  const insCurBatch = db.transaction((rows: IndexEntry[]) => {
    for (const e of rows) insCur.run(e.path);
  });
  for (let i = 0; i < entries.length; i += INGEST_BATCH) {
    insCurBatch(entries.slice(i, i + INGEST_BATCH));
    await yieldToEventLoop();
  }
  db.exec('DELETE FROM files WHERE path NOT IN (SELECT path FROM cur_paths)');
  db.exec('DROP TABLE cur_paths');

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
  for (let i = 0; i < entries.length; i += INGEST_BATCH) {
    upsertBatch(entries.slice(i, i + INGEST_BATCH));
    await yieldToEventLoop();
  }
}

/** Filename/path/tags fuzzy search via FTS5 trigram (>=3 chars) or LIKE (<3). */
export function queryFiles(rootPath: string, q: string): IndexEntry[] {
  const term = q.trim();
  if (!term) return [];
  const db = getDb(rootPath);
  let rows: FileRow[];
  if (term.length >= 3) {
    rows = db
      .prepare(
        `SELECT f.* FROM files_fts
         JOIN files f ON f.rowid = files_fts.rowid
         WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(ftsPhrase(term), QUERY_LIMIT) as FileRow[];
  } else {
    const like = `%${term}%`;
    rows = db
      .prepare(
        `SELECT * FROM files WHERE name LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
         ORDER BY is_dir DESC, name LIMIT ?`
      )
      .all(like, like, QUERY_LIMIT) as FileRow[];
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
  const rows = db.prepare(sql).all(...params) as FileRow[];
  return rows.map(rowToEntry);
}

/** All distinct tags across the index (for the advanced-search tag picker). */
export function distinctTags(rootPath: string): string[] {
  const db = getDb(rootPath);
  const rows = db.prepare("SELECT tags FROM files WHERE tags != ''").all() as Pick<FileRow, 'tags'>[];
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of r.tags.split(' ')) {
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Prior fulltext records (path → {mtime, content}) for incremental rebuild. */
export function fulltextPrior(
  rootPath: string
): Map<string, { mtime: number; content: string }> {
  if (!existsSync(dbPath(rootPath))) return new Map();
  const db = getDb(rootPath);
  const rows = db
    .prepare('SELECT path, mtime, content FROM fulltext_fts')
    .all() as { path: string; mtime: number; content: string }[];
  const m = new Map<string, { mtime: number; content: string }>();
  for (const r of rows) m.set(r.path, { mtime: r.mtime, content: r.content });
  return m;
}

/**
 * Replaces the full-text index with `records` (full rebuild). The DELETE runs
 * once; inserts are committed in `INGEST_BATCH`-sized transactions with an
 * event-loop yield between each, so a large corpus doesn't freeze the main
 * process. The fulltext index is a rebuildable cache, so dropping the single-
 * transaction atomicity is acceptable.
 */
export async function ingestFulltext(
  rootPath: string,
  records: FulltextRecord[]
): Promise<void> {
  const db = getDb(rootPath);
  const ins = db.prepare(
    'INSERT INTO fulltext_fts(path, name, mtime, content) VALUES (?, ?, ?, ?)'
  );
  db.exec('DELETE FROM fulltext_fts');
  const insBatch = db.transaction((recs: FulltextRecord[]) => {
    for (const r of recs) ins.run(r.path, r.name, r.mtime, r.content);
  });
  for (let i = 0; i < records.length; i += INGEST_BATCH) {
    insBatch(records.slice(i, i + INGEST_BATCH));
    await yieldToEventLoop();
  }
}

/**
 * Full-text search: returns hits with a snippet excerpt. Hit paths are absolute
 * (root + the stored relative path).
 */
export function queryFulltext(rootPath: string, q: string): FulltextHit[] {
  const term = q.trim();
  if (term.length < 3) return []; // trigram needs >= 3 chars
  const db = getDb(rootPath);
  const rows = db
    .prepare(
      `SELECT path, name,
         snippet(fulltext_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet
       FROM fulltext_fts WHERE fulltext_fts MATCH ?
       ORDER BY rank LIMIT 100`
    )
    .all(ftsPhrase(term)) as { path: string; name: string; snippet: string }[];
  return rows.map((r) => ({
    path: path.join(rootPath, ...r.path.split('/')),
    name: r.name,
    snippet: r.snippet,
  }));
}

/** True if the root has any full-text content indexed. */
export function hasFulltext(rootPath: string): boolean {
  if (!existsSync(dbPath(rootPath))) return false;
  const db = getDb(rootPath);
  const r = db.prepare('SELECT count(*) AS c FROM fulltext_fts').get() as { c: number };
  return r.c > 0;
}

/** Index status: how many files are indexed, and whether one exists at all. */
export function indexStatus(rootPath: string): { count: number; ready: boolean } {
  if (!existsSync(dbPath(rootPath))) return { count: 0, ready: false };
  const db = getDb(rootPath);
  const r = db.prepare('SELECT count(*) AS c FROM files').get() as { c: number };
  return { count: r.c, ready: r.c > 0 };
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

/** Wipe the EXIF cache for `rootPath`. Used by the "Refresh EXIF" button to
 *  force a full re-extraction. */
export function clearExifProcessed(rootPath: string): void {
  if (!existsSync(dbPath(rootPath))) return;
  const db = getDb(rootPath);
  db.exec('DELETE FROM exif_processed');
}
