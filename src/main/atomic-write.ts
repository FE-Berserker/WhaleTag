import path from 'path';
import { promises as fsp } from 'fs';
import { canonicalPathKey } from './path-fold';

/**
 * Monotonic counter making each temp filename unique within this process. Two
 * concurrent writes to the SAME target would otherwise share `${target}.${pid}.tmp`
 * (same pid), and the first rename would leave the second renaming a vanished
 * temp (ENOENT). The counter gives every in-flight write its own temp file.
 */
let tmpCounter = 0;
function tmpPathFor(filePath: string): string {
  tmpCounter += 1;
  return `${filePath}.${process.pid}.${tmpCounter}.tmp`;
}

/**
 * Targets whose stale temps have already been swept this session. The sweep
 * `readdir`s the whole target directory (expensive in high-cardinality dirs
 * like `.whale/thumbs/`), and atomic writes are extremely frequent (every
 * sidecar / index / thumbnail / folder-meta write) — so re-sweeping the same
 * target on every write is O(n) per write, O(n²) over n thumbnails. Stale temps
 * only arise from actual crashes (a normal write renames/removes its own temp),
 * and a lingering temp from a LATER crash has a unique name (pid + counter) and
 * can't collide with future writes — it just waits for the next session's first
 * sweep. So memoizing per-target is safe.
 */
const sweptTargets = new Set<string>();

/** Serialize writes per canonical target; unrelated targets still run in parallel. */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * `pendingWrites` / `sweptTargets` are keyed by {@link canonicalPathKey}: one
 * key per target regardless of `.`/separator/case spelling or symlink alias.
 */

/**
 * Removes stale temp files left by previous crashed writes of the same target.
 * The caller serializes same-target writes, so every matching temp here is from
 * an earlier crash rather than another in-flight write in this process.
 */
async function removeStaleTempsFor(filePath: string): Promise<void> {
  const key = canonicalPathKey(filePath);
  if (sweptTargets.has(key)) return;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    const entries = await fsp.readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => {
          if (!entry.startsWith(`${base}.`)) return false;
          // Match only `${target}.${pid}.${counter}.tmp`. A plain prefix +
          // suffix check would also treat `foo.jpg.123.1.tmp` as a stale temp
          // for target `foo` and could delete that other target's live write.
          return /^\d+\.\d+\.tmp$/.test(entry.slice(base.length + 1));
        })
        .map((entry) => fsp.rm(path.join(dir, entry), { force: true }))
    );
    sweptTargets.add(key);
  } catch {
    // Directory may not exist or be unreadable; ignore. The actual write will
    // surface any real permission problem.
  }
}

/**
 * Shared atomic-write implementation: open a sibling temp file, write through the
 * file descriptor, `datasync` the data to disk, close, and rename over the target.
 *
 * `datasync` before `rename` guarantees that the bytes we are about to make
 * visible via rename have actually reached stable storage. Without it, a crash
 * after rename could expose a partially-flushed temp file as the target,
 * corrupting `.whale/wsd.json` and other critical files.
 *
 * `tmp` lives next to the target (same volume), so the final rename never hits
 * a cross-device (EXDEV) error.
 */
/** Extra knobs shared by the three atomic-write helpers. */
export interface AtomicWriteOptions {
  /**
   * POSIX permission bits for the final file (e.g. `0o600` for documents that
   * hold a bearer token). Omitted means Node's default 0o666 & ~umask.
   * Windows ignores the mode; the option is a no-op there.
   */
  mode?: number;
}

async function atomicWriteNow(
  filePath: string,
  write: (fd: fsp.FileHandle) => Promise<void>,
  mode?: number
): Promise<void> {
  const tmp = tmpPathFor(filePath);
  let fd: fsp.FileHandle | undefined;
  try {
    await removeStaleTempsFor(filePath);
    fd = await fsp.open(tmp, 'w', mode);
    await write(fd);
    if (mode !== undefined) {
      // Harden the same open descriptor before publishing the temp file. A
      // chmod failure must abort the rename instead of silently exposing a
      // token document with permissions wider than the caller requested.
      await fd.chmod(mode);
    }
    await fd.datasync();
    await fd.close();
    fd = undefined;
    await fsp.rename(tmp, filePath);
  } catch (e) {
    if (fd) {
      await fd.close().catch(() => undefined);
    }
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Queue writes to the same target. Besides keeping the stale-temp sweep away
 * from live temp files, this avoids Windows EPERM when two renames race to
 * replace one destination. A failed write does not poison the next queued one.
 */
async function atomicWrite(
  filePath: string,
  write: (fd: fsp.FileHandle) => Promise<void>,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const key = canonicalPathKey(filePath);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => atomicWriteNow(filePath, write, options.mode));
  pendingWrites.set(key, run);
  try {
    await run;
  } finally {
    if (pendingWrites.get(key) === run) pendingWrites.delete(key);
  }
}

/**
 * Writes `data` to `filePath` atomically: write to a sibling temp file, flush
 * data to disk, then rename over the target. A crash mid-write leaves the
 * previous file intact instead of a truncated/corrupt one — critical for the
 * index / sidecar files the app relies on. The temp file is removed if writing
 * or renaming fails.
 */
export async function atomicWriteText(
  filePath: string,
  data: string,
  options?: AtomicWriteOptions
): Promise<void> {
  return atomicWrite(filePath, (fd) => fd.writeFile(data, 'utf8'), options);
}

/** Atomic write of a JSON value (pretty-printed with 2-space indent). */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  options?: AtomicWriteOptions
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(value, null, 2), options);
}

/**
 * Atomic write of raw bytes (e.g. a generated thumbnail). Same temp+rename
 * strategy as `atomicWriteText`, but the buffer is written verbatim (no UTF-8
 * encoding). A crash mid-write leaves the previous file intact.
 */
export async function atomicWriteBytes(
  filePath: string,
  data: Buffer,
  options?: AtomicWriteOptions
): Promise<void> {
  // Buffer hits a TS 5.9 + @types/node 20 friction: Buffer.slice().buffer is
  // ArrayBufferLike but writeFile's overload wants ArrayBuffer. Node accepts
  // Buffer at runtime, so assert past the type-only mismatch.
  return atomicWrite(filePath, (fd) => fd.writeFile(data as never), options);
}
