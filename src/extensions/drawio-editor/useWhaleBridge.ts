import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExtensionMessage,
  HostMessage,
} from '../../shared/extension-types';

export interface WhaleFile {
  path: string;
  content: string;
  readOnly: boolean;
}

/** Snapshot of an in-flight external drag — the iframe receives this from
 *  the host on drag-start and consumes it on drop. Mirrors the shape used
 *  by the Excalidraw editor (`src/extensions/excalidraw-editor/app.tsx`). */
export interface ExternalDragInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  /** True iff the host's `isImageFile` check (`shared/whale-meta.ts`) said
   *  this entry is an image. Drives the cell shape in `app.tsx`: images
   *  render as an mxImage cell, everything else renders as a labelled
   *  rectangle (PDFs, video, code, folders, …). */
  isImage: boolean;
}

export function useWhaleBridge() {
  const [file, setFile] = useState<WhaleFile | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [locale, setLocale] = useState<string>('en');
  const [readOnly, setReadOnly] = useState(false);
  const requestSaveRef = useRef<(() => void) | null>(null);
  // Last external drag — set by `externalDrag` envelope, consumed by the
  // drop handler in `app.tsx`. `null` means "no drag in progress".
  const externalDragRef = useRef<ExternalDragInfo | null>(null);

  const post = useCallback(
    (msg: ExtensionMessage) => window.whaleExt.postMessage(msg as { type: string; [key: string]: unknown }),
    []
  );

  useEffect(() => {
    const off = window.whaleExt.onMessage((msg: HostMessage) => {
      switch (msg.type) {
        case 'fileContent':
          setFile({
            path: msg.path,
            content: msg.content,
            readOnly: msg.readOnly,
          });
          setReadOnly(msg.readOnly);
          break;
        case 'setTheme':
          setTheme(msg.theme);
          break;
        case 'setReadOnly':
          setReadOnly(msg.readOnly);
          break;
        case 'setLocale':
          setLocale(msg.locale);
          break;
        case 'requestSave':
          requestSaveRef.current?.();
          break;
        case 'savingFile':
          // Handled by the caller via onSave callback if needed.
          break;
        case 'externalDrag':
          // Only react to drag-start (active:true). Starting a native OS drag
          // fires the source's HTML5 dragend immediately, so a drag-end signal
          // would clear the path before the drop — ignore it and clear on drop
          // or via a safety timeout in `app.tsx`.
          if (msg.active && msg.path) {
            externalDragRef.current = {
              path: msg.path,
              name: msg.name ?? '',
              isDirectory: !!msg.isDirectory,
              isImage: !!msg.isImage,
            };
          }
          break;
        default:
          break;
      }
    });

    window.whaleExt.postMessage({ type: 'ready' });
    setLocale(window.whaleExt.locale);
    return off;
  }, []);

  const setDirty = useCallback(
    (dirty: boolean) => {
      if (!file) return;
      post({
        type: 'contentChangedInEditor',
        path: file.path,
        dirty,
      });
    },
    [file, post]
  );

  const save = useCallback(
    (content: string) => {
      if (!file) return;
      post({
        type: 'parentSaveDocument',
        path: file.path,
        content,
      });
    },
    [file, post]
  );

  const onRequestSave = useCallback((fn: () => void) => {
    requestSaveRef.current = fn;
  }, []);

  /** Ask the host for a thumbnail + metadata for `path` (called by the drop
   *  handler in `app.tsx`). The host answers via a `fileEmbed` envelope,
   *  which `app.tsx` consumes via `onFileEmbed`. */
  const requestFileEmbed = useCallback(
    (path: string, isDirectory: boolean) => {
      post({ type: 'requestFileEmbed', path, isDirectory });
    },
    [post]
  );

  /** Clear the in-flight drag after a successful insert (so a follow-up drag
   *  gets a clean slate). */
  const clearExternalDrag = useCallback(() => {
    externalDragRef.current = null;
  }, []);

  return {
    file,
    theme,
    locale,
    readOnly,
    setDirty,
    save,
    onRequestSave,
    externalDragRef,
    requestFileEmbed,
    clearExternalDrag,
  };
}
