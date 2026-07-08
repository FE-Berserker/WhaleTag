import path from 'path';
import { promises as fsp } from 'fs';

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
 * Removes stale temp files left by previous crashed writes of the same target.
 * Whale is a single-instance desktop app, so there is no legitimate concurrent
 * atomic write to the same target; any matching `*.tmp` sibling is therefore
 * debris from an earlier crash and can be safely deleted.
 */
async function removeStaleTempsFor(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    const entries = await fsp.readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith('.tmp'))
        .map((entry) => fsp.rm(path.join(dir, entry), { force: true }))
    );
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
async function atomicWrite(
  filePath: string,
  write: (fd: fsp.FileHandle) => Promise<void>
): Promise<void> {
  const tmp = tmpPathFor(filePath);
  let fd: fsp.FileHandle | undefined;
  try {
    await removeStaleTempsFor(filePath);
    fd = await fsp.open(tmp, 'w');
    await write(fd);
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
 * Writes `data` to `filePath` atomically: write to a sibling temp file, flush
 * data to disk, then rename over the target. A crash mid-write leaves the
 * previous file intact instead of a truncated/corrupt one — critical for the
 * index / sidecar files the app relies on. The temp file is removed if writing
 * or renaming fails.
 */
export async function atomicWriteText(
  filePath: string,
  data: string
): Promise<void> {
  return atomicWrite(filePath, (fd) => fd.writeFile(data, 'utf8'));
}

/** Atomic write of a JSON value (pretty-printed with 2-space indent). */
export async function atomicWriteJson(
  filePath: string,
  value: unknown
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(value, null, 2));
}

/**
 * Atomic write of raw bytes (e.g. a generated thumbnail). Same temp+rename
 * strategy as `atomicWriteText`, but the buffer is written verbatim (no UTF-8
 * encoding). A crash mid-write leaves the previous file intact.
 */
export async function atomicWriteBytes(
  filePath: string,
  data: Buffer
): Promise<void> {
  // Buffer hits a TS 5.9 + @types/node 20 friction: Buffer.slice().buffer is
  // ArrayBufferLike but writeFile's overload wants ArrayBuffer. Node accepts
  // Buffer at runtime, so assert past the type-only mismatch.
  return atomicWrite(filePath, (fd) => fd.writeFile(data as never));
}
