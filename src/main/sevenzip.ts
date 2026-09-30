import { execFile } from 'child_process';
import { existsSync } from 'fs';

/**
 * Locates the 7za binary (7zip-bin's bundled binary or system PATH).
 *
 * Extracted from the old `archive.ts` (archive-viewer) — the remaining consumer
 * is archive-viewer's `.7z` listing.
 *
 * Memoized PATH-probe result for the bare `7za` command. The probe runs as an
 * asynchronous `execFile` so the main process never blocks on a cold PATH
 * lookup (up to 3s on first call — the same problem P1-1 fixed for
 * `sofficeBinary`). First-callers share a single in-flight probe via
 * `_sevenZipInflight`; the override / env / bundled checks above still run
 * synchronously (cheap existsSync) on every call.
 */
let _sevenZipOnPath: boolean | undefined;
let _sevenZipInflight: Promise<boolean> | null = null;

/**
 * Locates the 7za binary. Priority:
 *  1. explicit override
 *  2. WHALE_7ZA_PATH environment variable
 *  3. 7zip-bin bundled binary
 *  4. system PATH (async `7za --version` probe)
 */
export async function sevenZipBinary(
  override?: string | null
): Promise<string | null> {
  if (override) return override;

  const env = process.env.WHALE_7ZA_PATH;
  if (env && existsSync(env)) return env;

  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const sevenZip = require('7zip-bin');
    if (sevenZip?.path7za && existsSync(sevenZip.path7za)) {
      return sevenZip.path7za;
    }
  } catch {
    // bundled binary unavailable
  }

  if (_sevenZipOnPath === undefined) {
    if (!_sevenZipInflight) {
      _sevenZipInflight = new Promise<boolean>((resolve) => {
        execFile('7za', ['--version'], { timeout: 3000 }, (err) => {
          _sevenZipOnPath = !err;
          _sevenZipInflight = null;
          resolve(_sevenZipOnPath);
        });
      });
    }
    await _sevenZipInflight;
  }
  return _sevenZipOnPath ? '7za' : null;
}

export async function isSevenZipAvailable(): Promise<boolean> {
  return (await sevenZipBinary(null)) !== null;
}
