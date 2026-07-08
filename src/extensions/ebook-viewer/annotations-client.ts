/**
 * Bridge between ebook-viewer and the host's annotation IPC channels.
 *
 * The extension sends `requestReadEbookAnnotations` / `requestWriteEbookAnnotations`
 * over postMessage and listens for `ebookAnnotations` responses keyed by
 * `requestId`. This module wraps that round-trip in promise-returning helpers
 * and centralizes the pending-request bookkeeping.
 *
 * The host is ExtensionHost.tsx, which forwards to main/ipc.ts →
 * ebook-annotations.ts (read/write `.whale/ebook-annotations/<basename>.json`).
 */

import type { EbookAnnotations } from '../../shared/ebook-annotations';

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

let pendingReads = new Map<string, Pending<EbookAnnotations | null>>();
let pendingWrites = new Map<string, Pending<void>>();
let reqCounter = 0;

/** Generates a short unique request id; uniqueness is per-extension-lifetime. */
function nextRequestId(): string {
  reqCounter += 1;
  return `ea-${Date.now().toString(36)}-${reqCounter}`;
}

/**
 * Installs the response listener. Call exactly once during extension bootstrap.
 * Returns an unsubscribe function (mostly for symmetry / tests).
 */
export function installAnnotationsClient(onMessage: (handler: (msg: any) => void) => () => void): void {
  onMessage((msg) => {
    if (!msg || msg.type !== 'ebookAnnotations') return;
    const { requestId, ok, payload, error } = msg as {
      requestId: string;
      ok: boolean;
      payload?: unknown;
      error?: string;
    };

    if (pendingReads.has(requestId)) {
      const slot = pendingReads.get(requestId)!;
      pendingReads.delete(requestId);
      if (!ok) slot.reject(new Error(error || 'read failed'));
      else slot.resolve((payload ?? null) as EbookAnnotations | null);
      return;
    }
    if (pendingWrites.has(requestId)) {
      const slot = pendingWrites.get(requestId)!;
      pendingWrites.delete(requestId);
      if (!ok) slot.reject(new Error(error || 'write failed'));
      else slot.resolve(undefined);
    }
  });
}

export function readAnnotations(path: string): Promise<EbookAnnotations | null> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingReads.set(requestId, { resolve, reject });
    window.whaleExt.postMessage({
      type: 'requestReadEbookAnnotations',
      requestId,
      path,
    });
  });
}

export function writeAnnotations(path: string, payload: EbookAnnotations): Promise<void> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingWrites.set(requestId, { resolve, reject });
    window.whaleExt.postMessage({
      type: 'requestWriteEbookAnnotations',
      requestId,
      path,
      payload,
    });
  });
}

/** Test-only — clears the bookkeeping maps. Not exported in production code. */
export function __resetForTests(): void {
  pendingReads = new Map();
  pendingWrites = new Map();
  reqCounter = 0;
}