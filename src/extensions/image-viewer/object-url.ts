/**
 * Revocable blob-URL bookkeeping for the image viewer.
 *
 * The viewer used to hand `<img>` a `data:` URL built from the base64 file
 * content. Those URLs are never released: switching files (or closing the tab)
 * left the decoded bitmap of every visited image alive for the lifetime of the
 * iframe, which on a directory of large photos is a straight leak.
 *
 * Blob URLs can be revoked, but only if the viewer remembers exactly which URL
 * it handed out — hence this tiny scope instead of ad-hoc `URL.createObjectURL`
 * calls scattered through the loader.
 */

export interface ObjectUrlScope {
  /** Replace the tracked URL with a fresh one for `blob`. */
  replace(blob: Blob): string;
  /** Revoke the tracked URL (idempotent). */
  release(): void;
  /** The URL currently handed to the DOM, if any. */
  current(): string | null;
}

export interface ObjectUrlScopeDeps {
  create?: (blob: Blob) => string;
  revoke?: (url: string) => void;
}

export function createObjectUrlScope(
  deps: ObjectUrlScopeDeps = {}
): ObjectUrlScope {
  const create = deps.create ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revoke = deps.revoke ?? ((url: string) => URL.revokeObjectURL(url));
  let current: string | null = null;

  return {
    replace(blob) {
      if (current !== null) {
        revoke(current);
        current = null;
      }
      current = create(blob);
      return current;
    },
    release() {
      if (current !== null) {
        revoke(current);
        current = null;
      }
    },
    current() {
      return current;
    },
  };
}

/** Decode the base64 payload the host sends into bytes for a `Blob`. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Build the image blob for one `fileContent` message. */
export function imageBlobFor(content: string, mime: string): Blob {
  return new Blob([base64ToBytes(content)], { type: mime });
}
