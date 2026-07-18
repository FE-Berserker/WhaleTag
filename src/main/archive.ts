import path from 'path';
import os from 'os';
import fs, { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { unzipSync, gunzipSync } from 'fflate';
import { assertWithinAllowedRoot } from './allowed-roots';
import { atomicWriteBytes } from './atomic-write';
import {
  ArchiveEntry,
  ListArchiveOptions,
  ListArchiveResult,
  ReadArchiveEntryOptions,
  ReadArchiveEntryResult,
  ExtractArchiveOptions,
  ExtractArchiveResult,
} from '../shared/archive-types';

// ---------------------------------------------------------------------------
// 7zip-bin detection
// ---------------------------------------------------------------------------

// Memoized PATH-probe result for the bare `7za` command. The probe runs as
// an asynchronous `execFile` so the main process never blocks on a cold PATH
// lookup (the prior `execFileSync` form could freeze every window / IPC for
// up to 3s on first call — the same problem P1-1 fixed for `sofficeBinary`).
// First-callers share a single in-flight probe via `_sevenZipInflight`; the
// override / env / bundled checks above still run synchronously (cheap
// existsSync) on every call.
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

// ---------------------------------------------------------------------------
// Format classification
// ---------------------------------------------------------------------------

function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

function archiveFormat(srcPath: string): 'zip' | 'tar' | 'tgz' | 'gz' | 'sevenZip' {
  const name = path.basename(srcPath).toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tgz';
  if (name.endsWith('.tar.bz2') || name.endsWith('.tbz2')) return 'sevenZip';
  if (name.endsWith('.tar.xz') || name.endsWith('.txz')) return 'sevenZip';
  const ext = extOf(name);
  if (ext === 'zip') return 'zip';
  if (ext === 'tar') return 'tar';
  if (ext === 'gz') return 'gz';
  if (['bz2', 'xz', '7z'].includes(ext)) return 'sevenZip';
  // Fallback: try to sniff magic? For now treat unknown as 7z-able.
  return 'sevenZip';
}

/** Normalizes an archive path to POSIX separators. */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True if the entry path is safe (no absolute, no ../ traversal). */
function isSafeArchivePath(entryPath: string): boolean {
  const posix = posixPath(entryPath);
  if (posix.startsWith('/')) return false;
  const parts = posix.split('/');
  let depth = 0;
  for (const part of parts) {
    if (part === '..') depth -= 1;
    else if (part !== '.' && part !== '') depth += 1;
    if (depth < 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ZIP via fflate
// ---------------------------------------------------------------------------

function listZipEntries(data: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  unzipSync(data, {
    filter: (file) => {
      const p = posixPath(file.name);
      if (isMacOsResourceFork(p)) return false;
      const isDir = p.endsWith('/');
      entries.push({
        path: isDir ? p.replace(/\/$/, '') : p,
        size: Number(file.originalSize ?? 0),
        compressedSize: Number(file.size ?? 0),
        mtime: 0,
        isDir,
      });
      return false;
    },
  });
  return entries;
}

function readZipEntry(data: Uint8Array, entryPath: string): Uint8Array {
  const out = unzipSync(data, {
    filter: (f) => posixPath(f.name) === entryPath,
  });
  const found = Object.entries(out).find(([k]) => posixPath(k) === entryPath)?.[1];
  if (!found) throw new Error(`ZIP entry not found: ${entryPath}`);
  return found;
}

function extractZipEntries(
  data: Uint8Array,
  destDir: string,
  options: ExtractArchiveOptions
): ExtractArchiveResult {
  const result: ExtractArchiveResult = { written: 0, skipped: [], errors: [] };
  const out = unzipSync(data, {
    filter: (f) => {
      const p = posixPath(f.name);
      if (isMacOsResourceFork(p)) return false;
      if (!isSafeArchivePath(p)) {
        result.skipped.push(p);
        return false;
      }
      if (p.endsWith('/')) return false;
      return true;
    },
  });

  for (const [entryPath, bytes] of Object.entries(out)) {
    const p = posixPath(entryPath);
    try {
      const outPath = makeExtractPath(destDir, p, options.flatten);
      if (existsSync(outPath)) {
        result.skipped.push(p);
        continue;
      }
      atomicWriteBytesSync(outPath, Buffer.from(bytes));
      result.written += 1;
    } catch (e) {
      result.errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

function atomicWriteBytesSync(filePath: string, data: Buffer): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tmp, data as Uint8Array);
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// TAR / TGZ via fflate + minimal USTAR/PAX parser
// ---------------------------------------------------------------------------

function parseOctal(buf: Uint8Array, start: number, length: number): number {
  let result = 0;
  for (let i = start; i < start + length; i += 1) {
    const c = buf[i];
    if (c === 0 || c === 0x20) continue;
    if (c < 0x30 || c > 0x37) return NaN;
    result = result * 8 + (c - 0x30);
  }
  return result;
}

function readTarString(buf: Uint8Array, start: number, length: number): string {
  let end = start + length;
  while (end > start && buf[end - 1] === 0) end -= 1;
  return Buffer.from(buf.subarray(start, end)).toString('utf8');
}

interface TarHeader {
  name: string;
  size: number;
  mtime: number;
  type: 'file' | 'dir' | 'symlink' | 'other';
}

function* listTarHeaders(data: Uint8Array): Generator<TarHeader> {
  let offset = 0;
  let paxPath = '';
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header[0] === 0) break;

    const name = readTarString(header, 0, 100);
    const size = parseOctal(header, 124, 12);
    const mtime = parseOctal(header, 136, 12) * 1000;
    const typeFlag = header[156];
    offset += 512;

    // PAX extended header: 'x' (0x78) or 'g' (0x67)
    if (typeFlag === 0x78 || typeFlag === 0x67) {
      const content = Buffer.from(data.subarray(offset, offset + size)).toString('utf8');
      const match = content.match(/\npath=([^\n]+)\n/);
      if (match) paxPath = match[1];
      offset += Math.ceil(size / 512) * 512;
      continue;
    }

    let fullName = paxPath || name;
    // Handle USTAR prefix (bytes 345-500)
    if (!paxPath) {
      const prefix = readTarString(header, 345, 155);
      if (prefix) fullName = `${prefix}/${name}`;
    }
    fullName = posixPath(fullName).replace(/\/$/, '');

    if (typeFlag === 0x35 || (typeFlag === 0x00 && name.endsWith('/'))) {
      yield { name: fullName, size: 0, mtime, type: 'dir' };
    } else if (typeFlag === 0x30 || typeFlag === 0x00) {
      yield { name: fullName, size, mtime, type: 'file' };
      offset += Math.ceil(size / 512) * 512;
    } else if (typeFlag === 0x32) {
      yield { name: fullName, size: 0, mtime, type: 'symlink' };
    } else {
      yield { name: fullName, size, mtime, type: 'other' };
      offset += Math.ceil(size / 512) * 512;
    }
    paxPath = '';
  }
}

function readTarEntryContent(data: Uint8Array, entryPath: string): Uint8Array | null {
  let offset = 0;
  let paxPath = '';
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header[0] === 0) break;

    const name = readTarString(header, 0, 100);
    const size = parseOctal(header, 124, 12);
    const typeFlag = header[156];
    offset += 512;

    if (typeFlag === 0x78 || typeFlag === 0x67) {
      const content = Buffer.from(data.subarray(offset, offset + size)).toString('utf8');
      const match = content.match(/\npath=([^\n]+)\n/);
      if (match) paxPath = match[1];
      offset += Math.ceil(size / 512) * 512;
      continue;
    }

    let fullName = paxPath || name;
    if (!paxPath) {
      const prefix = readTarString(header, 345, 155);
      if (prefix) fullName = `${prefix}/${name}`;
    }
    fullName = posixPath(fullName).replace(/\/$/, '');

    if (fullName === entryPath) {
      if (typeFlag === 0x30 || typeFlag === 0x00) {
        return data.subarray(offset, offset + size);
      }
      return null;
    }

    if (typeFlag === 0x30 || typeFlag === 0x00 || typeFlag > 0x39) {
      offset += Math.ceil(size / 512) * 512;
    }
    paxPath = '';
  }
  return null;
}

function listTarEntries(data: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const h of listTarHeaders(data)) {
    if (isMacOsResourceFork(h.name)) continue;
    entries.push({
      path: h.name,
      size: h.size,
      compressedSize: 0,
      mtime: h.mtime,
      isDir: h.type === 'dir',
    });
  }
  return entries;
}

function extractTarEntries(
  data: Uint8Array,
  destDir: string,
  options: ExtractArchiveOptions
): ExtractArchiveResult {
  const result: ExtractArchiveResult = { written: 0, skipped: [], errors: [] };
  for (const h of listTarHeaders(data)) {
    const p = h.name;
    if (isMacOsResourceFork(p)) continue;
    if (!isSafeArchivePath(p)) {
      result.skipped.push(p);
      continue;
    }
    if (h.type === 'dir') continue;
    if (h.type === 'symlink' || h.type === 'other') {
      result.skipped.push(p);
      continue;
    }
    const content = readTarEntryContent(data, p);
    if (content == null) {
      result.errors.push(`${p}: could not read entry`);
      continue;
    }
    try {
      const outPath = makeExtractPath(destDir, p, options.flatten);
      if (existsSync(outPath)) {
        result.skipped.push(p);
        continue;
      }
      atomicWriteBytesSync(outPath, Buffer.from(content));
      result.written += 1;
    } catch (e) {
      result.errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// .gz single-file wrapper
// ---------------------------------------------------------------------------

function listGzEntries(srcPath: string): ArchiveEntry[] {
  const base = path.basename(srcPath, '.gz');
  return [
    {
      path: base || 'untitled',
      size: 0,
      compressedSize: 0,
      mtime: 0,
      isDir: false,
    },
  ];
}

function readGzEntry(data: Uint8Array): Uint8Array {
  return gunzipSync(data);
}

// ---------------------------------------------------------------------------
// 7za-based formats: 7z, bz2, xz, tar.bz2, tar.xz
// ---------------------------------------------------------------------------

function sevenZipPasswordArg(password?: string): string {
  // 7za uses -p followed by the password; with no password, -p means "prompt".
  // In non-interactive exec we must supply an empty password to avoid hanging.
  return password != null ? `-p${password}` : '-p""';
}

async function runSevenZipList(bin: string, srcPath: string, password?: string): Promise<ArchiveEntry[]> {
  const args = ['l', '-slt', '-bb0', '-bse0', sevenZipPasswordArg(password), '--', srcPath];
  // Async execFile (was execFileSync) so a slow/large archive can no longer
  // freeze the whole main process for up to 60s. maxBuffer raised well above
  // execFile's 1MB default so big listings (up to the 100k-entry cap) aren't
  // truncated — execFileSync buffered without that limit.
  const output = await new Promise<string>((resolve, reject) => {
    execFile(bin, args, { timeout: 60000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
  return parseSevenZipList(output, path.basename(srcPath));
}

export function parseSevenZipList(output: string, srcName: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const blocks = output.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const kv: Record<string, string> = {};
    for (const line of lines) {
      const sep = line.indexOf(' = ');
      if (sep > 0) kv[line.slice(0, sep)] = line.slice(sep + 3);
    }
    const p = kv.Path;
    if (!p) continue;
    const posixP = posixPath(p).replace(/\/$/, '');
    // 7za lists the archive itself as an entry in some versions; skip it.
    if (posixP === '' || posixP === srcName || posixP.endsWith(`/${srcName}`)) continue;
    if (isMacOsResourceFork(posixP)) continue;
    const isDir = kv.Folder === '+' || kv.Attributes?.startsWith('D') || kv.Attributes?.includes(' D');
    const size = parseInt(kv.Size ?? '0', 10) || 0;
    const compressed = parseInt(kv['Packed Size'] ?? '0', 10) || 0;
    const mtime = kv.Modified ? new Date(kv.Modified).getTime() : 0;
    entries.push({
      path: posixP,
      size,
      compressedSize: compressed,
      mtime,
      isDir,
      crc32: kv.CRC,
    });
  }
  return entries;
}

async function runSevenZipReadEntry(
  bin: string,
  srcPath: string,
  entryPath: string,
  password?: string
): Promise<Buffer> {
  const args = ['x', '-so', sevenZipPasswordArg(password), '--', srcPath, entryPath];
  // Async execFile (was execFileSync) — see runSevenZipList. stdout is a Buffer
  // because no `encoding` is set; cast escapes execFile's string-typed callback.
  return new Promise<Buffer>((resolve, reject) => {
    // `encoding: 'buffer'` is required: execFile defaults to 'utf8', which
    // would hand us a *string* and `new Uint8Array(string)` then yields an
    // empty array (string coerces to NaN length).
    execFile(bin, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as unknown as Buffer);
    });
  });
}

async function runSevenZipExtract(
  bin: string,
  srcPath: string,
  destDir: string,
  password?: string
): Promise<ExtractArchiveResult> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-archive-'));
  try {
    const args = ['x', '-y', sevenZipPasswordArg(password), `-o${tmpDir}`, '--', srcPath];
    await new Promise<void>((resolve, reject) => {
      execFile(bin, args, { timeout: 300000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const result: ExtractArchiveResult = { written: 0, skipped: [], errors: [] };
    await walkAndMove(tmpDir, destDir, tmpDir, result, false);
    return result;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function walkAndMove(
  root: string,
  destDir: string,
  current: string,
  result: ExtractArchiveResult,
  flatten: boolean
): Promise<void> {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      result.skipped.push(posixPath(path.relative(root, full)));
      continue;
    }
    if (entry.isDirectory()) {
      await walkAndMove(root, destDir, full, result, flatten);
      continue;
    }
    if (!entry.isFile()) {
      result.skipped.push(posixPath(path.relative(root, full)));
      continue;
    }

    const rel = path.relative(root, full);
    const posixRel = posixPath(rel);
    if (!isSafeArchivePath(posixRel)) {
      result.skipped.push(posixRel);
      continue;
    }

    const outPath = flatten
      ? path.join(destDir, entry.name)
      : path.join(destDir, rel);

    // Security: final destination must remain inside an allowed root.
    try {
      assertWithinAllowedRoot(outPath);
    } catch {
      result.skipped.push(posixRel);
      continue;
    }

    if (existsSync(outPath)) {
      result.skipped.push(posixRel);
      continue;
    }
    try {
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.rename(full, outPath);
      result.written += 1;
    } catch (e) {
      result.errors.push(`${posixRel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMacOsResourceFork(name: string): boolean {
  return (
    name.startsWith('__MACOSX/') ||
    name.includes('/__MACOSX/') ||
    name.endsWith('/.DS_Store') ||
    name === '.DS_Store'
  );
}

function makeExtractPath(destDir: string, entryPath: string, flatten?: boolean): string {
  if (flatten) {
    const base = path.posix.basename(entryPath);
    return path.join(destDir, base);
  }
  return path.join(destDir, ...entryPath.split('/'));
}

function bufferToBase64(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listArchive(
  srcPath: string,
  options: ListArchiveOptions = {}
): Promise<ListArchiveResult> {
  const maxEntries = options.maxEntries ?? 100_000;
  const fmt = archiveFormat(srcPath);

  let entries: ArchiveEntry[];
  if (fmt === 'zip') {
    const data = await fsp.readFile(srcPath);
    entries = listZipEntries(new Uint8Array(data));
  } else if (fmt === 'tar' || fmt === 'tgz') {
    let data = await fsp.readFile(srcPath);
    if (fmt === 'tgz') data = Buffer.from(gunzipSync(new Uint8Array(data)));
    entries = listTarEntries(new Uint8Array(data));
  } else if (fmt === 'gz') {
    entries = listGzEntries(srcPath);
  } else {
    const bin = await sevenZipBinary(null);
    if (!bin) throw new Error('7za not found');
    entries = await runSevenZipList(bin, srcPath, options.password);
  }

  entries = entries.filter((e) => isSafeArchivePath(e.path));
  const truncated = entries.length > maxEntries;
  if (truncated) entries = entries.slice(0, maxEntries);
  return { entries, truncated };
}

export async function readArchiveEntry(
  srcPath: string,
  entryPath: string,
  options: ReadArchiveEntryOptions = {}
): Promise<ReadArchiveEntryResult> {
  if (!isSafeArchivePath(entryPath)) {
    throw new Error(`Unsafe archive path: ${entryPath}`);
  }

  const fmt = archiveFormat(srcPath);
  let bytes: Uint8Array;

  if (fmt === 'zip') {
    const data = new Uint8Array(await fsp.readFile(srcPath));
    bytes = readZipEntry(data, entryPath);
  } else if (fmt === 'tar' || fmt === 'tgz') {
    let data = await fsp.readFile(srcPath);
    if (fmt === 'tgz') data = Buffer.from(gunzipSync(new Uint8Array(data)));
    const found = readTarEntryContent(new Uint8Array(data), entryPath);
    if (!found) throw new Error(`TAR entry not found: ${entryPath}`);
    bytes = found;
  } else if (fmt === 'gz') {
    const data = new Uint8Array(await fsp.readFile(srcPath));
    bytes = readGzEntry(data);
  } else {
    const bin = await sevenZipBinary(null);
    if (!bin) throw new Error('7za not found');
    bytes = new Uint8Array(await runSevenZipReadEntry(bin, srcPath, entryPath, options.password));
  }

  return { base64: bufferToBase64(bytes), size: bytes.byteLength };
}

export async function extractArchive(
  srcPath: string,
  destDir: string,
  options: ExtractArchiveOptions = {}
): Promise<ExtractArchiveResult> {
  assertWithinAllowedRoot(destDir);
  await fsp.mkdir(destDir, { recursive: true });

  const fmt = archiveFormat(srcPath);
  if (fmt === 'zip') {
    const data = new Uint8Array(await fsp.readFile(srcPath));
    return extractZipEntries(data, destDir, options);
  }
  if (fmt === 'tar' || fmt === 'tgz') {
    let data = await fsp.readFile(srcPath);
    if (fmt === 'tgz') data = Buffer.from(gunzipSync(new Uint8Array(data)));
    return extractTarEntries(new Uint8Array(data), destDir, options);
  }
  if (fmt === 'gz') {
    const data = new Uint8Array(await fsp.readFile(srcPath));
    const bytes = readGzEntry(data);
    const base = path.basename(srcPath, '.gz') || 'untitled';
    const outPath = path.join(destDir, base);
    const result: ExtractArchiveResult = { written: 0, skipped: [], errors: [] };
    if (existsSync(outPath)) {
      result.skipped.push(base);
    } else {
      await atomicWriteBytes(outPath, Buffer.from(bytes));
      result.written = 1;
    }
    return result;
  }

  const bin = await sevenZipBinary(null);
  if (!bin) throw new Error('7za not found');
  return runSevenZipExtract(bin, srcPath, destDir, options.password);
}
