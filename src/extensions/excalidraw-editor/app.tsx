import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Excalidraw,
  serializeAsJSON,
  restore,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import {
  linkToAbsolute,
  linkToRelative,
  rewriteExcalidrawJsonToRelative,
} from './excalidraw-links';
import {
  beginExcalidrawSave,
  createExcalidrawSaveState,
  observeExcalidrawJson,
  resetObservedJson,
  resolveExcalidrawSaveAck,
} from './save-state';
import { createInitialContentDeferred } from './initial-content';
import { parseExcalidrawScene } from './scene-content';
import { createDropRequestStore, type DropRequestStore } from './drop-requests';

// Excalidraw's imperative API is typed in a deep subpath that doesn't resolve
// cleanly under this project's `moduleResolution: node`; this is glue code in a
// sandboxed iframe, so a loose type here is acceptable.
type AnyApi = any;

export default function App() {
  const apiRef = useRef<AnyApi>(null);
  const pathRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string>('');
  const saveStateRef = useRef(createExcalidrawSaveState());
  const baselinePendingRef = useRef(false);
  const dirtyRef = useRef(false);
  // A rejected restore leaves Excalidraw on an empty scene. Never let that
  // placeholder be saved over the source document; the host also blocks Save
  // and exposes its retry surface for fatal restore errors.
  const restoreFailedRef = useRef(true);
  // Excalidraw exposes its imperative API before async scene initialization.
  // Feed the first host document through initialData so initializeScene cannot
  // overwrite an early updateScene with an empty scene (upstream 0.18.1 race).
  const initialContentRef = useRef<ReturnType<
    typeof createInitialContentDeferred
  > | null>(null);
  if (!initialContentRef.current) {
    initialContentRef.current = createInitialContentDeferred();
  }

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [viewMode, setViewMode] = useState(false);

  // A non-image file being dragged in from Whale's directory tree (path supplied
  // by the host since the sandboxed iframe can't read the dropped File's path).
  const externalDragRef = useRef<{ path: string; isImage: boolean } | null>(
    null
  );
  // Scene coordinates of the drops that are waiting for a `fileEmbed` reply,
  // keyed by request id. Several drops can be in flight at once (thumbnail
  // generation is async); the reply is placed only at the coordinates of the
  // drop that asked for it.
  const dropRequestsRef = useRef<DropRequestStore | null>(null);
  if (!dropRequestsRef.current) {
    dropRequestsRef.current = createDropRequestStore({
      onTimeout: (requestId) => {
        console.warn(
          '[excalidraw] fileEmbed request expired before the host replied:',
          requestId
        );
      },
    });
  }
  const dropRequestSeqRef = useRef(0);
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

  const setDirty = useCallback((dirty: boolean, force = false) => {
    if (!force && dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    if (pathRef.current) {
      window.whaleExt.postMessage({
        type: 'contentChangedInEditor',
        path: pathRef.current,
        dirty,
        revision: saveStateRef.current.revision,
      });
    }
  }, []);

  const restoreScene = useCallback((path: string, content: string) => {
    try {
      const data = restore(parseExcalidrawScene(content) as any, null, null);
      restoreFailedRef.current = false;
      return data;
    } catch (error) {
      restoreFailedRef.current = true;
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Could not restore Excalidraw scene: ${detail}`;
      window.whaleExt.postMessage({ type: 'error', message, path, fatal: true });
      throw error;
    }
  }, []);

  const loadInitialData = useCallback(async () => {
    const initial = initialContentRef.current!;
    const { path, content } = await initial.promise;
    initial.consumed = true;
    const data = restoreScene(path, content);
    pathRef.current = path;
    saveStateRef.current = createExcalidrawSaveState();
    baselinePendingRef.current = true;
    // A retry may have inherited dirty state from the failed previous iframe.
    // Force the successful disk restore to reconcile the host even when this
    // new editor's local dirtyRef already starts at false.
    setDirty(false, true);
    return {
      elements: data.elements,
      appState: data.appState,
      files: data.files,
    };
  }, [restoreScene, setDirty]);

  /** Applies a subsequent host document after initialData has initialized the
   *  scene (for example, a host-driven reload). */
  const applyScene = useCallback((path: string, content: string) => {
    const api = apiRef.current;
    if (!api) return;
    const data = restoreScene(path, content);
    pathRef.current = path;
    saveStateRef.current = createExcalidrawSaveState();
    // docs/20: stored element links are relative to the .excalidraw file's
    // directory (so a folder move keeps links intact). We keep them RELATIVE
    // in the scene too — the editor shows relative, the on-disk form is what
    // you see, and `onLinkOpen` resolves a relative link back to absolute at
    // click time before forwarding to the host. (No load-time rewrite.)
    baselinePendingRef.current = true;
    api.updateScene({ elements: data.elements, appState: data.appState });
    if (data.files) api.addFiles(Object.values(data.files));
    setDirty(false, true);
  }, [restoreScene, setDirty]);

  const doSave = useCallback(() => {
    const api = apiRef.current;
    if (!api || !pathRef.current || restoreFailedRef.current) return;
    // docs/20: links are stored relative. New inserts are already relative
    // (see insertFileEmbed); this pass also migrates any still-absolute links
    // from older files to relative. The pending baseline stays in runtime form,
    // which is what handleChange compares against.
    const absJson = computeJson();
    const save = beginExcalidrawSave(saveStateRef.current, absJson);
    saveStateRef.current = save.state;
    const content = rewriteExcalidrawJsonToRelative(absJson, pathRef.current);
    window.whaleExt.postMessage({
      type: 'parentSaveDocument',
      path: pathRef.current,
      content,
      revision: save.snapshot.revision,
    });
  }, [computeJson]);

  const handleChange = useCallback(() => {
    const currentJson = computeJson();
    // The first onChange after loading establishes the saved baseline so a fresh
    // load isn't reported as dirty or assigned a spurious edit revision.
    if (baselinePendingRef.current) {
      baselinePendingRef.current = false;
      lastSavedRef.current = currentJson;
      saveStateRef.current = resetObservedJson(saveStateRef.current, currentJson);
      setDirty(false);
      return;
    }
    saveStateRef.current = observeExcalidrawJson(saveStateRef.current, currentJson);
    setDirty(currentJson !== lastSavedRef.current);
  }, [computeJson, setDirty]);

  const handleApi = useCallback((api: AnyApi) => {
    apiRef.current = api;
  }, []);

  // Insert a non-image file as a thumbnail image element linked back to the file.
  // `position` comes from the drop that this reply belongs to; null means the
  // reply carried no usable correlation and the default spot is used.
  const insertFileEmbed = useCallback(
    (
      filePath: string,
      thumbnailDataUrl: string,
      position: { x: number; y: number } | null
    ) => {
      const api = apiRef.current;
      if (!api) return;
      const pos = position ?? { x: 100, y: 100 };
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
        api.addFiles([
          { id: fileId, mimeType, dataURL: thumbnailDataUrl, created: Date.now() },
        ] as any);
        const els = convertToExcalidrawElements([
          {
            type: 'image',
            x: pos.x,
            y: pos.y,
            width,
            height,
            fileId,
            // docs/20: store the link relative to this .excalidraw's directory
            // when the file lives inside it (survives a folder move); otherwise
            // keep it absolute. The editor shows this value verbatim.
            link: linkToRelative(filePath, pathRef.current ?? ''),
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
      dropRequestSeqRef.current += 1;
      const requestId = `drop-${dropRequestSeqRef.current}`;
      dropRequestsRef.current?.begin(requestId, pos);
      window.whaleExt.postMessage({
        type: 'requestFileEmbed',
        path: info.path,
        requestId,
      });
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
        case 'fileContent': {
          setViewMode(msg.readOnly);
          const initial = initialContentRef.current!;
          if (!initial.consumed) {
            initial.resolve({ path: msg.path, content: msg.content });
          } else {
            applyScene(msg.path, msg.content);
          }
          break;
        }
        case 'setTheme':
          setTheme(msg.theme);
          break;
        case 'setReadOnly':
          setViewMode(msg.readOnly);
          break;
        case 'requestSave':
          doSave();
          break;
        case 'savingFile': {
          const pending = saveStateRef.current.pendingSave;
          if (
            msg.path !== pathRef.current ||
            !pending ||
            (msg.revision !== undefined && msg.revision !== pending.revision)
          ) {
            break;
          }
          const currentJson = computeJson();
          saveStateRef.current = observeExcalidrawJson(
            saveStateRef.current,
            currentJson
          );
          const resolved = resolveExcalidrawSaveAck(pending, currentJson);
          saveStateRef.current = { ...saveStateRef.current, pendingSave: null };
          // Always advance the baseline to the write that actually completed.
          // A stale ack therefore preserves newer edits without leaving the
          // baseline permanently behind; edit-then-undo can still become clean.
          lastSavedRef.current = resolved.baselineJson;
          setDirty(resolved.dirty, true);
          break;
        }
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
        case 'fileEmbed': {
          // Correlate the reply with the drop that asked for it. Replies from a
          // host that does not echo `requestId` are still accepted, but only
          // when no correlated drop is waiting.
          const resolution = dropRequestsRef.current?.resolve(
            typeof msg.requestId === 'string' && msg.requestId
              ? msg.requestId
              : undefined
          );
          if (!resolution || !resolution.accepted) {
            console.warn(
              '[excalidraw] ignored an uncorrelated fileEmbed reply:',
              resolution?.reason ?? 'store-unavailable',
              msg.path
            );
            break;
          }
          insertFileEmbed(
            msg.path,
            msg.thumbnailDataUrl,
            resolution.position
          );
          break;
        }
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
        initialData={loadInitialData}
        theme={theme}
        viewModeEnabled={viewMode}
        onChange={handleChange}
        onLinkOpen={(_element, event) => {
          const el = _element as any;
          const link: string | null = el?.link ?? null;
          if (link && !/^https?:/i.test(link)) {
            event.preventDefault();
            (event as any).detail?.nativeEvent?.preventDefault?.();
            // docs/20: links are stored relative; resolve to an absolute path
            // against this .excalidraw's directory just before opening. (If the
            // path ref isn't set yet, forward as-is.)
            window.whaleExt.postMessage({
              type: 'openLinkExternally',
              url: pathRef.current ? linkToAbsolute(link, pathRef.current) : link,
            });
          }
        }}
      />
    </div>
  );
}
