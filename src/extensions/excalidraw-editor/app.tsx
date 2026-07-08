import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Excalidraw,
  serializeAsJSON,
  restore,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Excalidraw's imperative API is typed in a deep subpath that doesn't resolve
// cleanly under this project's `moduleResolution: node`; this is glue code in a
// sandboxed iframe, so a loose type here is acceptable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

export default function App() {
  const apiRef = useRef<AnyApi>(null);
  const pathRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string>('');
  const pendingSaveRef = useRef<string | null>(null);
  const baselinePendingRef = useRef(false);
  const dirtyRef = useRef(false);
  const pendingContentRef = useRef<{ path: string; content: string } | null>(
    null
  );

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [viewMode, setViewMode] = useState(false);

  // A non-image file being dragged in from Whale's directory tree (path supplied
  // by the host since the sandboxed iframe can't read the dropped File's path).
  const externalDragRef = useRef<{ path: string; isImage: boolean } | null>(
    null
  );
  // Scene coords where the next fileEmbed thumbnail should be placed.
  const pendingDropRef = useRef<{ x: number; y: number } | null>(null);
  // Safety timer to drop a stale external-drag path if no drop happens.
  const dragTimerRef = useRef<number | null>(null);

  const computeJson = useCallback((): string => {
    const api = apiRef.current;
    if (!api) return '';
    return serializeAsJSON(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
      'local'
    );
  }, []);

  const setDirty = useCallback((dirty: boolean) => {
    if (dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    if (pathRef.current) {
      window.whaleExt.postMessage({
        type: 'contentChangedInEditor',
        path: pathRef.current,
        dirty,
      });
    }
  }, []);

  /** Loads a .excalidraw document into the scene; buffers if the API isn't ready
   *  yet (the host may send fileContent before Excalidraw mounts). */
  const applyScene = useCallback((path: string, content: string) => {
    pathRef.current = path;
    const api = apiRef.current;
    if (!api) {
      pendingContentRef.current = { path, content };
      return;
    }
    let data;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data = restore(content ? (JSON.parse(content) as any) : {}, null, null);
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data = restore({} as any, null, null);
    }
    baselinePendingRef.current = true;
    api.updateScene({ elements: data.elements, appState: data.appState });
    if (data.files) api.addFiles(Object.values(data.files));
  }, []);

  const doSave = useCallback(() => {
    const api = apiRef.current;
    if (!api || !pathRef.current) return;
    const json = computeJson();
    pendingSaveRef.current = json;
    window.whaleExt.postMessage({
      type: 'parentSaveDocument',
      path: pathRef.current,
      content: json,
    });
  }, [computeJson]);

  const handleChange = useCallback(() => {
    // The first onChange after loading establishes the saved baseline so a fresh
    // load isn't reported as dirty.
    if (baselinePendingRef.current) {
      baselinePendingRef.current = false;
      lastSavedRef.current = computeJson();
      setDirty(false);
      return;
    }
    setDirty(computeJson() !== lastSavedRef.current);
  }, [computeJson, setDirty]);

  const handleApi = useCallback(
    (api: AnyApi) => {
      apiRef.current = api;
      const pending = pendingContentRef.current;
      if (pending) {
        pendingContentRef.current = null;
        applyScene(pending.path, pending.content);
      }
    },
    [applyScene]
  );

  // Insert a non-image file as a thumbnail image element linked back to the file.
  const insertFileEmbed = useCallback(
    (filePath: string, thumbnailDataUrl: string) => {
      const api = apiRef.current;
      if (!api) return;
      const pos = pendingDropRef.current ?? { x: 100, y: 100 };
      pendingDropRef.current = null;
      const img = new Image();
      img.onload = () => {
        const natW = img.naturalWidth || 120;
        const natH = img.naturalHeight || 150;
        const scale = Math.min(1, 200 / natW);
        const width = Math.round(natW * scale);
        const height = Math.round(natH * scale);
        const fileId = `whale-${Date.now().toString(36)}-${Math.floor(
          Math.random() * 1e9
        ).toString(36)}`;
        const mimeType = thumbnailDataUrl.startsWith('data:image/svg')
          ? 'image/svg+xml'
          : 'image/jpeg';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api.addFiles([
          { id: fileId, mimeType, dataURL: thumbnailDataUrl, created: Date.now() },
        ] as any);
        const els = convertToExcalidrawElements([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {
            type: 'image',
            x: pos.x,
            y: pos.y,
            width,
            height,
            fileId,
            link: filePath,
          } as any,
        ]);
        api.updateScene({ elements: [...api.getSceneElements(), ...els] });
      };
      img.src = thumbnailDataUrl;
    },
    []
  );

  // Capture-phase drop: intercept non-image external drags and embed a linked
  // thumbnail; let Excalidraw handle image drops natively.
  const handleDropCapture = useCallback((e: React.DragEvent) => {
    const info = externalDragRef.current;
    if (info && !info.isImage && info.path && apiRef.current) {
      e.preventDefault();
      e.stopPropagation();
      if (dragTimerRef.current) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }
      let pos = { x: 100, y: 100 };
      try {
        const scene = viewportCoordsToSceneCoords(
          { clientX: e.clientX, clientY: e.clientY },
          apiRef.current.getAppState()
        );
        pos = { x: scene.x, y: scene.y };
      } catch {
        // fall back to a default position
      }
      pendingDropRef.current = pos;
      window.whaleExt.postMessage({ type: 'requestFileEmbed', path: info.path });
      externalDragRef.current = null;
    }
  }, []);

  const handleDragOverCapture = useCallback((e: React.DragEvent) => {
    const info = externalDragRef.current;
    if (info && !info.isImage) e.preventDefault(); // allow the drop on our side
  }, []);

  useEffect(() => {
    const off = window.whaleExt.onMessage((msg) => {
      switch (msg.type) {
        case 'fileContent':
          setViewMode(msg.readOnly);
          applyScene(msg.path, msg.content);
          break;
        case 'setTheme':
          setTheme(msg.theme);
          break;
        case 'setReadOnly':
          setViewMode(msg.readOnly);
          break;
        case 'requestSave':
          doSave();
          break;
        case 'savingFile':
          lastSavedRef.current = pendingSaveRef.current ?? computeJson();
          pendingSaveRef.current = null;
          setDirty(false);
          break;
        case 'externalDrag':
          // Only react to drag-start (active:true). Starting a native OS drag
          // makes the source's HTML5 dragend fire immediately, so a drag-end
          // signal would clear the path before the drop — ignore it and instead
          // clear on drop or via a safety timeout. A new drag overwrites this.
          if (msg.active) {
            externalDragRef.current = {
              path: msg.path ?? '',
              isImage: !!msg.isImage,
            };
            if (dragTimerRef.current) window.clearTimeout(dragTimerRef.current);
            dragTimerRef.current = window.setTimeout(() => {
              externalDragRef.current = null;
            }, 15000);
          }
          break;
        case 'fileEmbed':
          insertFileEmbed(msg.path, msg.thumbnailDataUrl);
          break;
        default:
          break;
      }
    });
    window.whaleExt.postMessage({ type: 'ready' });
    return off;
  }, [applyScene, computeJson, doSave, setDirty, insertFileEmbed]);

  return (
    <div
      className="excalidraw-wrapper"
      onDropCapture={handleDropCapture}
      onDragOverCapture={handleDragOverCapture}
    >
      <Excalidraw
        excalidrawAPI={handleApi}
        theme={theme}
        viewModeEnabled={viewMode}
        onChange={handleChange}
        onLinkOpen={(_element, event) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const el = _element as any;
          const link: string | null = el?.link ?? null;
          if (link && !/^https?:/i.test(link)) {
            event.preventDefault();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (event as any).detail?.nativeEvent?.preventDefault?.();
            window.whaleExt.postMessage({
              type: 'openLinkExternally',
              url: link,
            });
          }
        }}
      />
    </div>
  );
}
