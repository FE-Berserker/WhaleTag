import path from 'path';
import { existsSync, promises as fsp } from 'fs';

/**
 * Reads a JSON file that is about to be **merged into** (read-modify-write).
 *
 * The lenient readers (`readFolderMeta`, `readTagLibrary`) return `{}` for a
 * missing OR corrupt file, which is fine for display but catastrophic for a
 * merge: `{...{}, ...patch}` would rewrite the whole file with just the one
 * changed field, silently dropping every other tag/description/perspective the
 * user had. This reader therefore distinguishes the two cases:
 *
 * - absent → `null` (start from empty, nothing to lose);
 * - unparsable or failing `isValid` → the file is **quarantined** to a
 *   `<name>.corrupt-<timestamp>` sibling and `null` is returned, so the merge
 *   proceeds without destroying the bytes (they stay recoverable) and without
 *   permanently bricking every later write on an unfixable file;
 * - any other IO error → **throws** — an unreadable file is not an empty one,
 *   and the caller must not write over data it could not read.
 */
export async function readJsonForMerge(
  filePath: string,
  isValid: (value: unknown) => boolean
): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Cannot read ${path.basename(filePath)} for a merge: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return quarantine(filePath, 'invalid JSON');
  }
  if (!isValid(parsed)) return quarantine(filePath, 'unexpected shape');
  return parsed;
}

/**
 * Moves a corrupt metadata file aside (never deletes it) so the next merge
 * starts from a known-empty state while the original bytes remain recoverable.
 * Throws when the rename itself fails — then the caller must not write.
 */
async function quarantine(filePath: string, reason: string): Promise<null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backup = `${filePath}.corrupt-${stamp}`;
  for (let n = 1; existsSync(backup); n += 1) {
    backup = `${filePath}.corrupt-${stamp}-${n}`;
  }
  try {
    await fsp.rename(filePath, backup);
  } catch (err) {
    throw new Error(
      `Metadata file is corrupt (${reason}) and could not be backed up at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  console.warn(
    `[meta] ${path.basename(filePath)} was corrupt (${reason}); moved to ${path.basename(backup)}`
  );
  return null;
}
