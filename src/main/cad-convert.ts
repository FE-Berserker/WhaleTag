import path from 'path';
import os from 'os';
import { existsSync, readdirSync, promises as fsp } from 'fs';
import { execFile, execFileSync } from 'child_process';

export interface ConvertDwgOptions {
  /** Explicit path to a LibreDWG `dwg2dxf` binary (skips auto-detection). */
  dwg2dxfPath?: string | null;
  /** Explicit path to the ODA File Converter binary (skips auto-detection). */
  odaPath?: string | null;
  /** Maximum time to wait for conversion, in milliseconds. */
  timeout?: number;
}

/**
 * Locate a LibreDWG `dwg2dxf` binary. It has no standard install path on
 * Windows, so detection relies on PATH (`dwg2dxf --version`). macOS brew and
 * Linux package-manager installs also land on PATH. Returns null if absent.
 */
export function dwg2dxfBinary(override?: string | null): string | null {
  if (override) return override;
  try {
    execFileSync('dwg2dxf', ['--version'], { timeout: 3000, stdio: 'ignore' });
    return 'dwg2dxf';
  } catch {
    return null;
  }
}

/**
 * Locate the ODA File Converter binary. ODA installs under a versioned dir
 * (e.g. `C:\Program Files\ODA\ODAFileConverter 27.1.0\`), so we scan the ODA
 * root for `ODAFileConverter *` subdirs rather than hardcoding version
 * numbers. We do NOT spawn it to probe PATH — ODA File Converter is a GUI app
 * and launching it (even with --help) pops a window. Returns null if absent.
 */
export function odaConverterBinary(override?: string | null): string | null {
  if (override) return override;
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
  await new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      ['-y', '-o', outDxf, srcPath],
      { timeout },
      (err) => (err ? reject(err) : resolve())
    );
  });
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
  await new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      [inDir, outDir, 'ACAD2018', 'DXF', '0', '0'],
      { timeout },
      (err) => (err ? reject(err) : resolve())
    );
  });
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
    const dwg2dxf = dwg2dxfBinary(options.dwg2dxfPath);
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
