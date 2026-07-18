import { existsSync } from 'fs';
import { execFile } from 'child_process';

/**
 * LibreOffice `soffice` binary discovery + shared CLI arg builder.
 *
 * Lifted out of `thumbnail.ts` to break the historical
 * `thumbnail.ts` ↔ `office-convert.ts` circular dependency (which only
 * worked because both sides only consumed these via function-level lazy
 * resolution and never at module top-level — a TDZ footgun waiting to
 * fire on any future refactor).
 *
 * Consumers:
 *  - `thumbnail.ts`         (`encodeOfficeThumb`)
 *  - `office-convert.ts`    (`convertOfficeToPdfVia` legacy fallback)
 *  - `office-worker/office-worker-host.ts` (worker boot probe)
 *  - `ipc.ts`               (`ext:isSofficeAvailable` handler)
 */

// Memoized PATH-probe result for the bare `soffice` command (spawns a child,
// up to 3s — LibreOffice's bootstrap can be slow on a cold Windows install).
// Cached so office thumbnails / PDF conversions don't re-probe on every call;
// the candidate-path checks below stay per-call (cheap existsSync). The probe
// itself runs via async `execFile` (P1-1 — execFileSync would block the main
// process event loop on cold PATH lookup and freeze every window / IPC).
// `_sofficeInflight` dedupes concurrent probes: the first caller kicks off the
// spawn, subsequent callers await the same Promise.
let _sofficeOnPath: boolean | undefined;
let _sofficeInflight: Promise<boolean> | null = null;

/**
 * Tries to locate the LibreOffice `soffice` binary. Honours an explicit
 * override, then common install locations, then PATH. Returns null when
 * LibreOffice cannot be found.
 */
export async function sofficeBinary(
  override: string | null | undefined
): Promise<string | null> {
  if (override) return override;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    candidates.push(
      '/usr/bin/soffice',
      '/usr/lib/libreoffice/program/soffice'
    );
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Final fallback: let PATH resolve it. Memoized (see _sofficeOnPath).
  if (_sofficeOnPath === undefined) {
    if (!_sofficeInflight) {
      _sofficeInflight = new Promise<boolean>((resolve) => {
        execFile(
          'soffice',
          ['--version'],
          { timeout: 3000 },
          (err) => {
            _sofficeOnPath = !err;
            _sofficeInflight = null;
            resolve(_sofficeOnPath);
          }
        );
      });
    }
    await _sofficeInflight;
  }
  return _sofficeOnPath ? 'soffice' : null;
}

/** Returns true when a LibreOffice `soffice` binary can be located. */
export async function isSofficeAvailable(): Promise<boolean> {
  return (await sofficeBinary(null)) !== null;
}

/**
 * Standard CLI args for converting an Office document to PDF via `soffice`.
 * Single source of truth shared by `encodeOfficeThumb` (thumbnail.ts) and
 * `convertOfficeToPdf` (office-convert.ts).
 *
 * `--norestore --nologo --nofirststartwizard` suppress LibreOffice's profile
 * restore / splash / first-start wizard, cutting cold-start overhead 30–50%
 * (typical Windows cold start 2–5s). The flags are no-ops when the profile
 * is already in steady state, so they're always safe to include.
 */
export function sofficeConvertArgs(tmpDir: string, srcPath: string): string[] {
  return [
    '--headless',
    '--norestore',
    '--nologo',
    '--nofirststartwizard',
    '--convert-to',
    'pdf',
    '--outdir',
    tmpDir,
    srcPath,
  ];
}
