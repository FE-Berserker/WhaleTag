import fs from 'fs';
import path from 'path';
import { foldPath } from './path-fold';

/**
 * Where the configured locations came from.
 *
 * `allowedRoots` (allowed-roots.ts) confines every read/write to the renderer's
 * registered locations, but the renderer *sends* that list — so on its own the
 * guard only stops bugs, not a compromised renderer: it could simply register
 * `/` and then touch anything. This module keeps a main-process record of the
 * directories the USER actually picked (native folder dialog), and the
 * `fs:setAllowedRoots` push is filtered through it.
 *
 * Seeding: an install that predates this file has its locations only in the
 * renderer's persisted state. On the first push after the upgrade we therefore
 * accept the whole list once ("trust on first use"), persist it, and from then
 * on only known directories are accepted. The seeded file lives in
 * `<userData>/known-roots.json` — outside every location, so a compromised
 * renderer cannot rewrite it through the guarded file APIs.
 *
 * Renaming a location folder on disk makes its stored path unknown; the user
 * re-adds it through the dialog (the same as before the path is valid again).
 */

const FILE_NAME = 'known-roots.json';
const DOC_VERSION = 1;

interface PersistedKnownRoots {
  version: number;
  roots: string[];
}

/** Folded key → the raw path as first recorded (display-correct). */
const knownRoots = new Map<string, string>();
let userDataDir: string | null = null;
/** True once the persisted document exists (or was just seeded). */
let seeded = false;
let writeQueue: Promise<void> = Promise.resolve();

function knownRootsPath(): string | null {
  return userDataDir ? path.join(userDataDir, FILE_NAME) : null;
}

/** Resolve through symlinks when possible, then fold for case-correct compare. */
function foldKey(raw: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(raw);
  } catch {
    resolved = path.resolve(raw);
  }
  return foldPath(resolved);
}

function isPersistedDoc(value: unknown): value is PersistedKnownRoots {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const roots = (value as { roots?: unknown }).roots;
  return (
    Array.isArray(roots) &&
    roots.every((root) => typeof root === 'string' && root.length > 0)
  );
}

/**
 * A directory squatting on the record path would make every future write
 * fail (rename over a directory is not allowed). Move it aside so the record
 * can be written again; its contents are preserved under a `.corrupt-` name.
 */
function quarantineRecord(file: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, backup);
    console.warn(
      `[roots] the known-locations path was a directory; moved it to ${backup}`
    );
  } catch (error) {
    console.warn(
      '[roots] the known-locations path is a directory and could not be moved:',
      error
    );
  }
}

/**
 * Load the record from `<userData>/known-roots.json`. A missing file means a
 * fresh install or an upgrade from before this guard existed: the next
 * renderer push seeds it. A corrupt file is treated the same way (re-seed)
 * rather than locking the user out of their own locations.
 */
export function initKnownRoots(dir: string): void {
  userDataDir = dir;
  knownRoots.clear();
  seeded = false;
  const file = knownRootsPath();
  if (!file) return;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'EISDIR') {
      quarantineRecord(file);
      return;
    }
    console.warn(
      '[roots] known-locations file is unreadable; re-seeding from the renderer push:',
      error
    );
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPersistedDoc(parsed)) throw new Error('unexpected shape');
    for (const raw of parsed.roots) knownRoots.set(foldKey(raw), raw);
    seeded = true;
  } catch (error) {
    console.warn(
      '[roots] known-locations file is corrupt; re-seeding from the renderer push:',
      error
    );
  }
}

/**
 * Records a directory the user picked in the native folder dialog. Called by
 * the dialog handler before the path is handed back to the renderer.
 */
export function rememberPickedRoot(raw: string): void {
  if (typeof raw !== 'string' || raw.trim() === '') return;
  knownRoots.set(foldKey(raw), raw);
  schedulePersist();
}

/**
 * Filters a renderer root push down to user-picked directories.
 *
 * - Before the first seed (fresh install / upgrade), the push itself seeds the
 *   record: everything absolute is accepted once and persisted.
 * - Afterwards only paths already in the record are accepted; the rest are
 *   reported as `refused` so the caller can log them.
 */
export function acceptRootsFromRenderer(roots: readonly string[]): {
  accepted: string[];
  refused: string[];
} {
  const accepted: string[] = [];
  const refused: string[] = [];

  if (!seeded) {
    for (const raw of roots) {
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      if (!path.isAbsolute(raw)) continue;
      knownRoots.set(foldKey(raw), raw);
      accepted.push(raw);
    }
    // Close the seeding window on the FIRST push even when it is empty: a
    // fresh install has no locations, and leaving `seeded` false would let an
    // injected renderer seed the record with `/` later in the session.
    seeded = true;
    if (accepted.length > 0) schedulePersist();
    return { accepted, refused };
  }

  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (knownRoots.has(foldKey(raw))) accepted.push(raw);
    else refused.push(raw);
  }
  return { accepted, refused };
}

/** True when `raw` resolves to a directory the user picked (or seeded). */
export function isKnownRoot(raw: string): boolean {
  if (knownRoots.size === 0) return false;
  return knownRoots.has(foldKey(raw));
}

function schedulePersist(): void {
  const file = knownRootsPath();
  if (!file) return;
  const payload: PersistedKnownRoots = {
    version: DOC_VERSION,
    roots: Array.from(knownRoots.values()),
  };
  writeQueue = writeQueue
    .then(() => writeDocument(file, payload))
    .catch((error) => {
      // Never throw at the caller: a location must stay usable even when the
      // record cannot be written (the next push re-attempts).
      console.error('[roots] failed to persist the known locations:', error);
    });
}

async function writeDocument(
  file: string,
  payload: PersistedKnownRoots
): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

/** Awaits every queued write (tests + graceful shutdown). */
export function flushKnownRootsWrites(): Promise<void> {
  return writeQueue;
}

/** Test seam: forget both the in-memory record and the userData directory. */
export function __resetKnownRootsForTest(): void {
  knownRoots.clear();
  seeded = false;
  userDataDir = null;
  writeQueue = Promise.resolve();
}
