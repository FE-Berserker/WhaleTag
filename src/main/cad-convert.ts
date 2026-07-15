import path from 'path';
import os from 'os';
import { existsSync, readdirSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { mediaConvertSemaphore } from './concurrency';

export interface ConvertDwgOptions {
  /** Explicit path to a LibreDWG `dwg2dxf` binary (skips auto-detection). */
  dwg2dxfPath?: string | null;
  /** Explicit path to the ODA File Converter binary (skips auto-detection). */
  odaPath?: string | null;
  /** Maximum time to wait for conversion, in milliseconds. */
  timeout?: number;
}

// Memoized PATH-probe result for the bare `dwg2dxf` command (spawns a child,
// up to 3s). Cached so opening multiple .dwg files doesn't re-probe each time.
// The probe runs via async `execFile` (P1-1 — execFileSync would block the main
// process on cold PATH lookup and freeze every window / IPC).
// `_dwg2dxfInflight` dedupes concurrent probes.
let _dwg2dxfOnPath: boolean | undefined;
let _dwg2dxfInflight: Promise<boolean> | null = null;

/**
 * Locate a LibreDWG `dwg2dxf` binary. It has no standard install path on
 * Windows, so detection relies on PATH (`dwg2dxf --version`). macOS brew and
 * Linux package-manager installs also land on PATH. Returns null if absent.
 */
export async function dwg2dxfBinary(
  override?: string | null
): Promise<string | null> {
  if (override) return override;
  if (_dwg2dxfOnPath === undefined) {
    if (!_dwg2dxfInflight) {
      _dwg2dxfInflight = new Promise<boolean>((resolve) => {
        execFile(
          'dwg2dxf',
          ['--version'],
          { timeout: 3000 },
          (err) => {
            _dwg2dxfOnPath = !err;
            _dwg2dxfInflight = null;
            resolve(_dwg2dxfOnPath);
          }
        );
      });
    }
    await _dwg2dxfInflight;
  }
  return _dwg2dxfOnPath ? 'dwg2dxf' : null;
}

// P3-5 (perf audit): memoized result of the no-override scan below. The scan
// does several `existsSync` + a `readdirSync`; ODA's install path can't change
// mid-session, so cache it. `undefined` = not yet probed.
let _odaCache: string | null | undefined;

/**
 * Locate the ODA File Converter binary. ODA installs under a versioned dir
 * (e.g. `C:\Program Files\ODA\ODAFileConverter 27.1.0\`), so we scan the ODA
 * root for `ODAFileConverter *` subdirs rather than hardcoding version
 * numbers. We do NOT spawn it to probe PATH — ODA File Converter is a GUI app
 * and launching it (even with --help) pops a window. Returns null if absent.
 */
export function odaConverterBinary(override?: string | null): string | null {
  if (override) return override;
  if (_odaCache !== undefined) return _odaCache;
  _odaCache = detectOdaConverter();
  return _odaCache;
}

/** Pure detection (no memo) — wrapped by `odaConverterBinary`. */
function detectOdaConverter(): string | null {
  if (process.platform === 'darwin') {
    const mac =
      '/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter';
    return existsSync(mac) ? mac : null;
  }
  const roots =
    process.platform === 'win32'
      ? ['C:\\Program Files\\ODA', 'C:\\Program Files (x86)\\ODA']
      : [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Non-versioned install: <root>\ODAFileConverter.exe
    const direct = path.join(root, 'ODAFileConverter.exe');
    if (existsSync(direct)) return direct;
    // Versioned install: <root>\ODAFileConverter <ver>\ODAFileConverter.exe
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const versionDirs = entries
      .filter((n) => /^ODAFileConverter\s+\d/i.test(n))
      .sort()
      .reverse(); // newest-looking first (lexical; fine for the common single install)
    for (const dir of versionDirs) {
      const exe = path.join(root, dir, 'ODAFileConverter.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/** Convert with LibreDWG `dwg2dxf` (clean single-file CLI, no GUI). */
async function convertWithDwg2dxf(
  bin: string,
  srcPath: string,
  outDxf: string,
  timeout: number
): Promise<Buffer> {
  await mediaConvertSemaphore.run(
    () =>
      new Promise<void>((resolve, reject) => {
        execFile(
          bin,
          ['-y', '-o', outDxf, srcPath],
          { timeout },
          (err) => (err ? reject(err) : resolve())
        );
      })
  );
  if (!existsSync(outDxf)) {
    throw new Error('dwg2dxf did not produce a DXF');
  }
  return fsp.readFile(outDxf);
}

/**
 * Convert with ODA File Converter. ODA operates on whole directories (and pops
 * a GUI progress window while running — unavoidable), so we stage the input
 * file in a temp `in` dir and read the result from a temp `out` dir.
 *
 * Args: <srcDir> <outDir> <ACADVersion> <DWG|DXF> <recurse> <audit>
 */
async function convertWithOda(
  bin: string,
  srcPath: string,
  inDir: string,
  outDir: string,
  timeout: number
): Promise<Buffer> {
  await fsp.copyFile(srcPath, path.join(inDir, path.basename(srcPath)));
  await mediaConvertSemaphore.run(
    () =>
      new Promise<void>((resolve, reject) => {
        execFile(
          bin,
          [inDir, outDir, 'ACAD2018', 'DXF', '0', '0'],
          { timeout },
          (err) => (err ? reject(err) : resolve())
        );
      })
  );
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const outDxf = path.join(outDir, `${baseName}.dxf`);
  if (!existsSync(outDxf)) {
    throw new Error('ODA File Converter did not produce a DXF');
  }
  return fsp.readFile(outDxf);
}

/**
 * Converts a DWG file to DXF bytes using an externally-installed free
 * converter. Prefers LibreDWG `dwg2dxf` (clean CLI); falls back to ODA File
 * Converter (higher fidelity, but pops a GUI window). Throws when neither is
 * installed or the conversion fails. The DXF bytes are then rendered by
 * cad-viewer's existing Tier-1 DXF path (buildDxfGroup) in the extension.
 */
export async function convertDwgToDxf(
  srcPath: string,
  options: ConvertDwgOptions = {}
): Promise<Buffer> {
  const timeout = options.timeout ?? 120000;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-dwg-'));
  try {
    const dwg2dxf = await dwg2dxfBinary(options.dwg2dxfPath);
    if (dwg2dxf) {
      const baseName = path.basename(srcPath, path.extname(srcPath));
      return await convertWithDwg2dxf(
        dwg2dxf,
        srcPath,
        path.join(tmpDir, `${baseName}.dxf`),
        timeout
      );
    }

    const oda = odaConverterBinary(options.odaPath);
    if (oda) {
      const inDir = path.join(tmpDir, 'in');
      const outDir = path.join(tmpDir, 'out');
      await fsp.mkdir(inDir);
      await fsp.mkdir(outDir);
      return await convertWithOda(oda, srcPath, inDir, outDir, timeout);
    }

    throw new Error(
      'No DWG converter found. Install LibreDWG (dwg2dxf) or ODA File Converter, then reopen the file.'
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
