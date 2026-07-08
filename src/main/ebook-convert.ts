import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { execFile, execFileSync } from 'child_process';

export interface ConvertEbookOptions {
  /** Explicit path to the Calibre `ebook-convert` binary. */
  calibrePath?: string | null;
  /** Maximum time to wait for conversion, in milliseconds. */
  timeout?: number;
}

/**
 * Locates the Calibre `ebook-convert` binary.
 *
 * Checks the user override first, then common platform install locations, then
 * falls back to searching PATH. Returns null when Calibre cannot be found.
 */
export function ebookConvertBinary(override?: string | null): string | null {
  if (override) return override;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Calibre2\\ebook-convert.exe',
      'C:\\Program Files (x86)\\Calibre2\\ebook-convert.exe'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/calibre.app/Contents/MacOS/ebook-convert');
  } else {
    candidates.push('/usr/bin/ebook-convert', '/usr/local/bin/ebook-convert');
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  try {
    execFileSync('ebook-convert', ['--version'], {
      timeout: 3000,
      stdio: 'ignore',
    });
    return 'ebook-convert';
  } catch {
    return null;
  }
}

/** Returns true when a Calibre `ebook-convert` binary can be located. */
export function isEbookConvertAvailable(): boolean {
  return ebookConvertBinary(null) !== null;
}

/**
 * Converts a MOBI/AZW/AZW3 ebook to EPUB bytes using Calibre's `ebook-convert`.
 *
 * The conversion runs in a temporary directory and the directory is cleaned up
 * afterwards. Returns the EPUB as a Buffer. Throws when Calibre is missing or
 * the conversion fails.
 */
export async function convertEbookToEpub(
  srcPath: string,
  options: ConvertEbookOptions = {}
): Promise<Buffer> {
  const bin = ebookConvertBinary(options.calibrePath);
  if (!bin || (options.calibrePath && !existsSync(bin))) {
    throw new Error('Calibre (ebook-convert) not found');
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ebook-'));
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const expectedEpub = path.join(tmpDir, `${baseName}.epub`);

  try {
    await new Promise<void>((resolve, reject) => {
      const isCmd = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(bin);
      execFile(
        bin,
        [srcPath, expectedEpub],
        { timeout: options.timeout ?? 120000, shell: isCmd },
        (err) => (err ? reject(err) : resolve())
      );
    });

    if (!existsSync(expectedEpub)) {
      throw new Error('Calibre did not produce an EPUB');
    }

    return fsp.readFile(expectedEpub);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
