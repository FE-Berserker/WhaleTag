import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { sofficeBinary, sofficeConvertArgs } from './thumbnail';
import { sofficeSemaphore } from './concurrency';
import * as officeWorkerHost from './office-worker/office-worker-host';

export interface ConvertOfficeOptions {
  /** Explicit path to the LibreOffice `soffice` binary. */
  sofficePath?: string | null;
  /** Maximum time to wait for conversion, in milliseconds. */
  timeout?: number;
}

/**
 * Convert an Office document to PDF at `outPdfPath` via the persistent UNO
 * worker when available, falling back to a one-shot `soffice --convert-to pdf`
 * spawn otherwise.
 *
 * Contract: `outPdfPath` MUST be `<dir>/<basename(srcPath) without ext>.pdf` —
 * i.e. the exact filename `soffice --convert-to` would emit into its `--outdir`.
 * The worker writes the file directly via `storeToURL`; the fallback lets
 * soffice write `<srcBase>.pdf` into `path.dirname(outPdfPath)`. Both callers
 * (`convertOfficeToPdf` and `encodeOfficeThumb`) construct the path this way.
 *
 * Both paths run inside `sofficeSemaphore.run` — the worker's Desktop is
 * single-threaded (loadComponentFromURL isn't concurrency-safe), and the
 * fallback shares the default LO profile lock. `ensureSpawned()` runs OUTSIDE
 * the semaphore so the first conversion's 2–6s worker boot doesn't block
 * other conversions.
 *
 * An explicit `sofficePath` (tests / user override) bypasses the worker: the
 * worker resolves its own soffice, and an override means "use THIS binary via
 * CLI". `WorkerUnavailableError` (worker in cooldown / boot failed / died
 * mid-request) falls through to the fallback; any other error is a real
 * per-document conversion failure and is propagated.
 */
export async function convertOfficeToPdfVia(
  srcPath: string,
  outPdfPath: string,
  options: ConvertOfficeOptions = {}
): Promise<void> {
  const useWorker =
    options.sofficePath == null && officeWorkerHost.isAvailable();
  if (useWorker) {
    try {
      // Boot OUTSIDE the semaphore — see method doc.
      await officeWorkerHost.ensureSpawned();
      await sofficeSemaphore.run(() =>
        officeWorkerHost.request(srcPath, outPdfPath)
      );
      return;
    } catch (e) {
      if (e instanceof officeWorkerHost.WorkerUnavailableError) {
        // Worker unavailable — fall through to the execFile path. The host
        // already applied a cooldown so subsequent calls short-circuit.
      } else {
        throw e; // real per-document conversion error
      }
    }
  }

  // Fallback: legacy one-shot `soffice --convert-to pdf`.
  const bin = await sofficeBinary(options.sofficePath);
  if (!bin) {
    throw new Error('LibreOffice (soffice) not found');
  }

  await sofficeSemaphore.run(
    () =>
      new Promise<void>((resolve, reject) => {
        const isCmd =
          process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(bin);
        execFile(
          bin,
          sofficeConvertArgs(path.dirname(outPdfPath), srcPath),
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
      })
  );
}

/**
 * Converts an Office document to PDF bytes. Thin shell over
 * `convertOfficeToPdfVia`: convert into a temp dir, read it back, clean up.
 *
 * Signature preserved (returns Buffer) so `office-cache.ts` and its tests are
 * untouched. Throws when LibreOffice is missing or the conversion fails;
 * stderr is captured into the error message so the caller sees real
 * LibreOffice diagnostics (missing fonts / Java / profile lock) instead of a
 * bare `Command failed: ...`.
 */
export async function convertOfficeToPdf(
  srcPath: string,
  options: ConvertOfficeOptions = {}
): Promise<Buffer> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-'));
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const outPdfPath = path.join(tmpDir, `${baseName}.pdf`);

  try {
    await convertOfficeToPdfVia(srcPath, outPdfPath, options);
    if (!existsSync(outPdfPath)) {
      throw new Error('LibreOffice did not produce a PDF');
    }
    return fsp.readFile(outPdfPath);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

/** Returns true when a LibreOffice `soffice` binary can be located. */
export async function isSofficeAvailable(): Promise<boolean> {
  return (await sofficeBinary(null)) !== null;
}
