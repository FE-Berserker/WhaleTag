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
  const timestamp = encodeTimestamp(new Date().toISOString());
  const revDir = revisionsDirFor(filePath);
  const revPath = path.join(revDir, `${timestamp}${ext}`);

  await fsp.mkdir(revDir, { recursive: true });
  await atomicWriteText(revPath, content);
}

/**
 * Backs up `filePath` by copying its raw bytes (binary-safe; used for images
 * and other non-text files). No-op when the file does not exist.
 */
export async function backupRevisionBinary(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;

  const ext = path.extname(filePath);
  const timestamp = encodeTimestamp(new Date().toISOString());
  const revDir = revisionsDirFor(filePath);
  const revPath = path.join(revDir, `${timestamp}${ext}`);

  await fsp.mkdir(revDir, { recursive: true });
  await fsp.copyFile(filePath, revPath);
}

/** Lists all revisions for a file, newest first. */
export async function listRevisions(filePath: string): Promise<RevisionInfo[]> {
  const revDir = revisionsDirFor(filePath);
  if (!existsSync(revDir)) return [];

  const entries = await fsp.readdir(revDir);
  const revisions: RevisionInfo[] = [];

  for (const entry of entries) {
    const fullPath = path.join(revDir, entry);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) continue;

    const dotIndex = entry.lastIndexOf('.');
    const encoded = dotIndex > 0 ? entry.slice(0, dotIndex) : entry;
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

/** Deletes a single revision file. */
export async function deleteRevision(revisionPath: string): Promise<void> {
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
      const remaining = await fsp.readdir(fullPath).catch(() => []);
      if (remaining.length === 0) {
        await fsp.rmdir(fullPath).catch(() => undefined);
      }
    } else if (entry.isFile()) {
      const stat = await fsp.stat(fullPath).catch(() => null);
      if (stat && stat.mtime.getTime() < cutoff) {
        await fsp.rm(fullPath, { force: true }).catch(() => undefined);
      }
    }
  }
}
