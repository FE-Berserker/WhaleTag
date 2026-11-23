/**
 * Shared "read a file for an extension tab" helper.
 *
 * Binary files are fetched through Main's `fs:readFileBase64` (one base64
 * string over IPC). The renderer must not read an `ArrayBuffer` and encode it
 * with `btoa` — that doubled memory for large binaries (base64 of the full
 * buffer, built one byte at a time) and blocked the UI thread. Main already
 * encodes with `Buffer.toString('base64')` after its allowed-roots check.
 *
 * Extracted from `ExtensionContextProvider` so the binary/text split and the
 * byte-size math can be tested without mounting the provider.
 */

import type { ExtensionEncoding } from '../../shared/extension-types';
import { isBinaryExtension } from '../../shared/whale-meta';
import { ipcApi } from '-/services/ipc-api';

export interface ExtensionFileContent {
  content: string;
  encoding: ExtensionEncoding;
  /** Size in bytes (decoded length, not the base64 string length). */
  size: number;
}

/**
 * Byte length of a base64 string without decoding it.
 *
 * `math:` 4 base64 chars carry 3 bytes; `=` padding marks bytes that are not
 * present. Kept dependency-free (no `atob` / `Buffer`) because it runs in the
 * sandboxed renderer.
 */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** Read a file for an extension tab, choosing the IPC path by extension. */
export async function readExtensionFileContent(
  filePath: string
): Promise<ExtensionFileContent> {
  const dot = filePath.lastIndexOf('.');
  const ext = dot > 0 ? filePath.slice(dot + 1).toLowerCase() : '';
  if (isBinaryExtension(ext)) {
    const content = await ipcApi.readFileBase64(filePath);
    return { content, encoding: 'base64', size: base64ByteLength(content) };
  }
  const content = await ipcApi.readTextFile(filePath);
  // Polyfill-free UTF-8 byte count (works in renderer, jsdom, modern browsers).
  return {
    content,
    encoding: 'utf8',
    size: new TextEncoder().encode(content).byteLength,
  };
}
