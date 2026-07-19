import { ipcMain } from 'electron';
import { extractGps, getExifSummary } from '../exif';
import { request } from '../index-worker-host';
import { setFulltextRoots } from '../dir-watcher';
import { assertWithinAllowedRoot } from '../allowed-roots';
import type { SearchQuery } from '../../shared/search-query';

/**
 * Search-index + EXIF handlers: thin forwarders to the index utilityProcess
 * (P0-2) plus the local EXIF probes. Split out of the old god-registrar
 * `ipc.ts` (docs/01 §12) — behavior is verbatim.
 *
 * `assertWithinAllowedRoot` stays in the main process — never trust the
 * renderer with path validation, and never duplicate the check downstream.
 * The worker trusts the inputs it receives from main.
 */

export function registerSearchIndexHandlers(): void {
  // ---- EXIF / GPS (Mapique perspective) ----
  ipcMain.handle('exif:extractGps', (_event, filePath: string) =>
    extractGps(filePath)
  );

  // P3-4: persisted EXIF extraction cache. Reads return the full record set
  // for the current root; writes upsert a single record. The renderer reads
  // on directory mount to skip files already known to lack GPS, and writes
  // back after each attempt.
  ipcMain.handle('exif:load-processed', (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath);
    return request('exif:load-processed', { rootPath });
  });
  // P3-7: popup EXIF summary. Lazy — the renderer fetches this when a
  // marker is clicked, never on the initial map render.
  ipcMain.handle('exif:get-summary', (_event, filePath: string) =>
    getExifSummary(filePath)
  );
  ipcMain.handle(
    'exif:mark-processed',
    (
      _event,
      rootPath: string,
      record: { path: string; status: 'ok' | 'none'; lat: number | null; lng: number | null; triedAt: number }
    ) => {
      assertWithinAllowedRoot(rootPath);
      return request('exif:mark-processed', { rootPath, record });
    }
  );
  // Batched variant — one IPC + one transaction (fsync) per batch instead of
  // per image. Used by the Mapique EXIF extractor for a whole folder at once.
  // P0-2: forwarded to the worker; the worker keeps the single-transaction
  // property (one WAL fsync per call, not per record).
  ipcMain.handle(
    'exif:mark-processed-many',
    (
      _event,
      rootPath: string,
      records: { path: string; status: 'ok' | 'none'; lat: number | null; lng: number | null; triedAt: number }[]
    ) => {
      assertWithinAllowedRoot(rootPath);
      return request('exif:mark-processed-many', { rootPath, records });
    }
  );
  ipcMain.handle('exif:clear-processed', (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath);
    return request('exif:clear-processed', { rootPath });
  });

  // ---- Index (SQLite, plan §6.6 P2) ----
  ipcMain.handle('index:build', async (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath); // writes <root>/.whale/index.db
    return request('index:build', { rootPath });
  });

  // Filename/path/tags fuzzy search (FTS5 trigram) — replaces the old in-memory
  // Fuse load+search. Returns IndexEntry[]; the renderer highlights client-side.
  ipcMain.handle('index:query', (_event, rootPath: string, q: string) =>
    request('index:query', { rootPath, q })
  );

  // Structured (advanced) search — the SearchQuery compiled to a SQL WHERE.
  ipcMain.handle('index:advanced', (_event, rootPath: string, q: SearchQuery) =>
    request('index:advanced', { rootPath, q })
  );

  ipcMain.handle('index:tags', (_event, rootPath: string) =>
    request('index:tags', { rootPath })
  );

  ipcMain.handle('index:status', (_event, rootPath: string) =>
    request('index:status', { rootPath })
  );

  // ---- Full-text index (SQLite FTS5, plan §6.6 P2) ----
  // buildFulltextIndex applies an incremental delta (insert changed/new, delete
  // removed, leave unchanged rows untouched), so there's no stale-incremental
  // state to clear first.
  ipcMain.handle('fulltext:build', (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath);
    return request('fulltext:build', { rootPath });
  });

  ipcMain.handle('fulltext:search', (_event, rootPath: string, query: string) =>
    request('fulltext:search', { rootPath, q: query })
  );

  ipcMain.handle('fulltext:has', (_event, rootPath: string) =>
    request('fulltext:has', { rootPath })
  );

  // docs/04 §10: the renderer pushes `settings.fulltextPaths` here so the
  // dir-watcher can schedule incremental `fulltext:build`s when the location
  // watchers see changes inside these roots.
  ipcMain.handle('fulltext:syncPaths', (_event, paths: string[]) => {
    for (const p of paths ?? []) assertWithinAllowedRoot(p);
    setFulltextRoots(paths ?? []);
  });
}
