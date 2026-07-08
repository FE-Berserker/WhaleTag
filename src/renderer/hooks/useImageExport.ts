import { useCallback, useState } from 'react';
import { useCurrentLocationContext } from './CurrentLocationContextProvider';
import { useDirectoryContentContext } from './DirectoryContentContextProvider';
import { ipcApi } from '-/services/ipc-api';
import { joinPath } from '-/services/path-util';

/** Strip the `data:image/png;base64,` prefix from a data URL. */
export function base64FromDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

interface UseImageExportOptions {
  /** Returns a base64-encoded PNG string, or null if the view is not ready. */
  capture: () => Promise<string | null>;
  /** Filename prefix for auto-generated names, e.g. `tag-cloud`. */
  prefix: string;
}

/**
 * What kind of payload landed on the clipboard. Callers should surface a
 * tailored notice for each — `image` is what users expect; `text` means the
 * environment couldn't write a PNG blob and the user got a base64 string
 * they can paste into an image app to decode.
 */
export type ClipboardKind = 'image' | 'text';

interface UseImageExportReturn {
  saving: boolean;
  error: string | null;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
  /**
   * Capture the view and put it on the system clipboard. Prefers image/png
   * via `navigator.clipboard.write`; falls back to a base64 string under
   * `text/plain` if image clipboard isn't available. Returns the kind of
   * payload that landed so callers can show a tailored notice.
   */
  handleCopyToClipboard: () => Promise<ClipboardKind>;
  clearError: () => void;
}

/**
 * Shared save/save-as flow for perspective views that export a rendered image.
 * Handles capture, filename generation, dialog, write, refresh, and error display.
 */
export function useImageExport({
  capture,
  prefix,
}: UseImageExportOptions): UseImageExportReturn {
  const { currentDirectoryPath } = useCurrentLocationContext();
  const { refresh } = useDirectoryContentContext();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const writeTo = useCallback(
    async (destPath: string) => {
      const base64 = await capture();
      if (!base64) {
        throw new Error('Failed to capture image');
      }
      await ipcApi.writeBinaryFile(destPath, base64);
      await refresh();
    },
    [capture, refresh]
  );

  /**
   * Decode a base64 PNG string into its bytes — the inverse of
   * `base64FromDataUrl`. Pulled out so `handleCopyToClipboard` doesn't depend
   * on the caller for byte conversion. Throws on invalid base64 (let the
   * ClipboardItem path surface the underlying `atob` error).
   */
  const base64ToPngBytes = useCallback((base64: string): Uint8Array => {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }, []);

  const handleCopyToClipboard = useCallback(async (): Promise<ClipboardKind> => {
    const base64 = await capture();
    if (!base64) throw new Error('Failed to capture image');
    // `.slice()` gives a fresh Uint8Array backed by a plain ArrayBuffer;
    // TS 5.7+ tightened Blob's BlobPart to require ArrayBuffer (not the
    // wider ArrayBufferLike that atob result exposes), so without this copy
    // `new Blob([bytes])` no longer type-checks. Same fix used by
    // archive-viewer/index.ts for the same reason.
    const bytes = base64ToPngBytes(base64).slice();
    const blob = new Blob([bytes], { type: 'image/png' });
    // Prefer image/png via the structured clipboard API. Older Electron / some
    // headless contexts don't expose `write` even when `writeText` works —
    // fall through to a base64 text payload rather than throw.
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return 'image';
      } catch {
        // fall through to text fallback
      }
    }
    await navigator.clipboard.writeText(`data:image/png;base64,${base64}`);
    return 'text';
  }, [capture, base64ToPngBytes]);

  const handleSave = useCallback(async () => {
    if (!currentDirectoryPath) return;
    setSaving(true);
    setError(null);
    try {
      const fileName = `${prefix}-${Date.now()}.png`;
      const destPath = joinPath(currentDirectoryPath, fileName);
      await writeTo(destPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [currentDirectoryPath, prefix, writeTo]);

  const handleSaveAs = useCallback(async () => {
    if (!currentDirectoryPath) return;
    setSaving(true);
    setError(null);
    let destPath: string | null = null;
    try {
      const defaultPath = joinPath(
        currentDirectoryPath,
        `${prefix}-${Date.now()}.png`
      );
      destPath = await ipcApi.saveImageDialog(defaultPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
      return;
    }
    if (!destPath) {
      setSaving(false);
      return;
    }
    try {
      await writeTo(destPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [currentDirectoryPath, prefix, writeTo]);

  return {
    saving,
    error,
    handleSave,
    handleSaveAs,
    handleCopyToClipboard,
    clearError: () => setError(null),
  };
}
