import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { sofficeBinary, sofficeConvertArgs } from './thumbnail';

export interface ConvertOfficeOptions {
  /** Explicit path to the LibreOffice `soffice` binary. */
  sofficePath?: string | null;
  /** Maximum time to wait for conversion, in milliseconds. */
  timeout?: number;
}

/**
 * Converts an Office document to PDF bytes using LibreOffice.
 *
 * The conversion runs in a temporary directory and the directory is cleaned up
 * afterwards. Returns the PDF as a Buffer. Throws when LibreOffice is missing
 * or the conversion fails. Stderr is captured into the error message so the
 * caller sees real LibreOffice diagnostics (missing fonts / Java / profile
 * lock) instead of a bare `Command failed: ...`.
 */
export async function convertOfficeToPdf(
  srcPath: string,
  options: ConvertOfficeOptions = {}
): Promise<Buffer> {
  const bin = sofficeBinary(options.sofficePath);
  if (!bin) {
    throw new Error('LibreOffice (soffice) not found');
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-'));
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const expectedPdf = path.join(tmpDir, `${baseName}.pdf`);

  try {
    await new Promise<void>((resolve, reject) => {
      const isCmd = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(bin);
      execFile(
        bin,
        sofficeConvertArgs(tmpDir, srcPath),
        {
          timeout: options.timeout ?? 120000,
          stdio: ['ignore', 'pipe', 'pipe'] as const,
          shell: isCmd,
        } as import('child_process').ExecFileOptions,
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `soffice failed: ${err.message}\n${stderr || stdout || ''}`
              )
            );
            return;
          }
          resolve();
        }
      );
    });

    if (!existsSync(expectedPdf)) {
      throw new Error('LibreOffice did not produce a PDF');
    }

    return fsp.readFile(expectedPdf);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Returns true when a LibreOffice `soffice` binary can be located. */
export function isSofficeAvailable(): boolean {
  return sofficeBinary(null) !== null;
}
