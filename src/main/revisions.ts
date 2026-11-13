import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { META_DIR } from '../shared/whale-meta';
import { atomicWriteText } from './atomic-write';
import type { RevisionInfo } from '../shared/extension-types';

const REVISIONS_DIR = 'revisions';

function revisionsDirFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, META_DIR, REVISIONS_DIR, base);
}

/**
 * Encodes an ISO timestamp so it is safe as a filename on Windows/Unix.
 * Colons are not allowed on Windows, so we replace them with dashes.
 */
function encodeTimestamp(ts: string): string {
  return ts.replace(/:/g, '-');
}

/** Last millisecond handed out — keeps two backups from sharing a filename. */
let lastRevisionMs = 0;

/**
 * Returns a timestamp whose revision filename is still free. Two saves in the
 * same millisecond used to write to the same path (the second silently
 * clobbered the first); bumping the clock by 1 ms keeps the ISO format — and
 * therefore the list order — intact.
 */
function nextTimestamp(revDir: string, ext: string): string {
  let ms = Math.max(Date.now(), lastRevisionMs + 1);
  for (let i = 0; i < 1000; i += 1) {
    const encoded = encodeTimestamp(new Date(ms).toISOString());
    if (!existsSync(path.join(revDir, `${encoded}${ext}`))) {
      lastRevisionMs = ms;
      return encoded;
    }
    ms += 1;
  }
  throw new Error('Could not allocate a unique revision timestamp');
}

/** Reverse of encodeTimestamp. */
function decodeTimestamp(encoded: string): string {
  // ISO strings contain colons at fixed positions; dashes elsewhere are date separators.
  // 2026-06-29T10-30-00.000Z -> 2026-06-29T10:30:00.000Z
  return encoded.replace(/T(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)$/, 'T$1:$2:$3');
}

/**
 * Backs up the current content of `filePath` to its revisions folder.
 * If the file does not exist, this is a no-op (nothing to backup).
 */
export async function backupRevision(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;

  const content = await fsp.readFile(filePath, 'utf8');
  const ext = path.extname(filePath);
  const revDir = revisionsDirFor(filePath);

  await fsp.mkdir(revDir, { recursive: true });
  const timestamp = nextTimestamp(revDir, ext);
  const revPath = path.join(revDir, `${timestamp}${ext}`);

  await atomicWriteText(revPath, content);
}

/** Lists all revisions for a file, newest first. */
export async function listRevisions(filePath: string): Promise<RevisionInfo[]> {
  const revDir = revisionsDirFor(filePath);
  if (!existsSync(revDir)) return [];

  const entries = await fsp.readdir(revDir);
  const revisions: RevisionInfo[] = [];
  // Revisions are `<encoded timestamp><ext>`; slice the source file's own
  // extension rather than the last dot — a file without an extension used to
  // lose the `.000Z` of its timestamp to the final-dot heuristic.
  const ext = path.extname(filePath);

  for (const entry of entries) {
    const fullPath = path.join(revDir, entry);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) continue;

    const encoded =
      ext && entry.endsWith(ext) ? entry.slice(0, -ext.length) : entry;
    revisions.push({
      timestamp: decodeTimestamp(encoded),
      path: fullPath,
      size: stat.size,
    });
  }

  return revisions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Restores a revision back to the original file path.
 * Verifies that the revision actually belongs to this file to prevent escapes.
 */
export async function restoreRevision(
  filePath: string,
  revisionPath: string
): Promise<void> {
  const revDir = revisionsDirFor(filePath);
  const resolvedRev = path.resolve(revisionPath);
  const resolvedDir = path.resolve(revDir);
  const prefix = resolvedDir.endsWith(path.sep)
    ? resolvedDir
    : `${resolvedDir}${path.sep}`;
  if (!resolvedRev.startsWith(prefix)) {
    throw new Error('Invalid revision path');
  }

  const content = await fsp.readFile(revisionPath, 'utf8');
  await atomicWriteText(filePath, content);
}

/**
 * Deletes a single revision file. Binds the revision to `filePath` (same
 * prefix check as {@link restoreRevision}) so a compromised renderer can't
 * turn this into an arbitrary-path delete — `force: true` bypasses the
 * recycle bin entirely.
 */
export async function deleteRevision(
  filePath: string,
  revisionPath: string
): Promise<void> {
  const revDir = revisionsDirFor(filePath);
  const resolvedRev = path.resolve(revisionPath);
  const resolvedDir = path.resolve(revDir);
  const prefix = resolvedDir.endsWith(path.sep)
    ? resolvedDir
    : `${resolvedDir}${path.sep}`;
  if (!resolvedRev.startsWith(prefix)) {
    throw new Error('Invalid revision path');
  }
  await fsp.rm(revisionPath, { force: true });
}

/**
 * Cleans up revisions older than `maxAgeDays` under a location root.
 * Removes files and prunes empty directories.
 */
export async function cleanupRevisionsForLocation(
  locationRoot: string,
  maxAgeDays: number
): Promise<void> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const revRoot = path.join(locationRoot, META_DIR, REVISIONS_DIR);
  if (!existsSync(revRoot)) return;
  await cleanupDir(revRoot, cutoff);
}

async function cleanupDir(dir: string, cutoff: number): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanupDir(fullPath, cutoff);
      const remaining = await fsp.readdir(fullPath).catch((e) => {
        // Keep the directory (and log it): an unreadable revision folder must
        // not be treated as empty and removed with its contents unknown.
        console.warn('[revisions] failed to inspect a revision folder:', fullPath, e);
        return [entry.name];
      });
      if (remaining.length === 0) {
        await fsp.rmdir(fullPath).catch((e) => {
          console.warn('[revisions] failed to prune an empty revision folder:', fullPath, e);
        });
      }
    } else if (entry.isFile()) {
      const stat = await fsp.stat(fullPath).catch(() => null);
      if (stat && stat.mtime.getTime() < cutoff) {
        await fsp.rm(fullPath, { force: true }).catch((e) => {
          console.warn('[revisions] failed to delete an expired revision:', fullPath, e);
        });
      }
    }
  }
}
