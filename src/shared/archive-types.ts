/**
 * Types shared between main / preload / renderer / archive-viewer extension
 * for the archive decoding IPC. Keep this file free of Node-only or DOM-only
 * imports.
 */

/** One entry inside an archive. Paths are POSIX-style ('/' separators). */
export interface ArchiveEntry {
  /** Entry path inside the archive, e.g. "folder/file.txt". */
  path: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Compressed size in bytes (0 when unavailable). */
  compressedSize: number;
  /** Modification time as epoch milliseconds (0 when unavailable). */
  mtime: number;
  /** True for directory entries. */
  isDir: boolean;
  /** CRC32 when available (hex string or undefined). */
  crc32?: string;
}

export interface ListArchiveOptions {
  /** Maximum entries to return; default 100_000. */
  maxEntries?: number;
  /** Archive password. Never persisted. */
  password?: string;
}

export interface ReadArchiveEntryOptions {
  /** Archive password. Never persisted. */
  password?: string;
  /** Bypass the zip-bomb ratio guard when the user explicitly confirms. */
  force?: boolean;
}

export interface ExtractArchiveOptions {
  /** Archive password. Never persisted. */
  password?: string;
  /** Flatten archive directory structure into destDir. */
  flatten?: boolean;
}

export interface ListArchiveResult {
  entries: ArchiveEntry[];
  /** True when the archive contained more entries than maxEntries. */
  truncated: boolean;
}

export interface ReadArchiveEntryResult {
  /** Base64-encoded entry bytes. */
  base64: string;
  /** Uncompressed size in bytes. */
  size: number;
}

export interface ExtractArchiveResult {
  /** Number of entries successfully written. */
  written: number;
  /** Entry paths that were skipped (zip-slip, symlinks, absolute paths). */
  skipped: string[];
  /** Per-entry error messages for entries that failed to write. */
  errors: string[];
}

/** Error class identifier returned over IPC for zip-bomb refusal. */
export class ZipBombError extends Error {
  constructor(
    message: string,
    public readonly ratio: number,
    public readonly compressed: number,
    public readonly uncompressed: number
  ) {
    super(message);
    this.name = 'ZipBombError';
  }
}
