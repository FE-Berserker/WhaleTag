import { useCallback, useEffect, useRef, useState } from 'react';
import { useWhaleBridge } from './useWhaleBridge';
import { getDrawioUrl, useDrawioBridge, type DrawioTheme } from './drawio-bridge';
import { nextDropPosition, uniqueCellId } from './drop-xml';
import { getMessages } from './locales';

export default function App() {
  const {
    file,
    locale,
    readOnly,
    setDirty,
    save,
    onRequestSave,
    externalDragRef,
    requestFileEmbed,
    clearExternalDrag,
  } = useWhaleBridge();
  const lastSavedRef = useRef<string>('');
  const pendingSaveRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  // External drag overlay (visible while a file/folder from the directory tree
  // is hovering over the drawio iframe). The overlay is a transparent `<div>`
  // on top of the inner drawio iframe — drawio's own drop handler lives in a
  // separate inner iframe and is invisible to outer-iframe listeners, so we
  // need this intercept layer to handle tree drops ourselves.
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  // Drop index — incremented on each successful insert so consecutive drops
  // don't overlap. Lives in a ref so it survives re-renders / unmounts.
  const dropIndexRef = useRef(0);
  // Safety timer to clear a stale `externalDragRef` if no drop happens.
  const dragTimerRef = useRef<number | null>(null);
  // Guards the initial file-load useEffect so it only fires once per file
  // path. Without this, every re-render (where `bridge` ref may change
  // even after the memo in `useDrawioBridge`) would re-post the original
  // `file.content` to drawio's `load` action, wiping the cell the user
  // just inserted via drag-drop. We key on `file.path` (not a boolean) so
  // switching from file A → file B re-loads B — a previous version used a
  // separate "reset" effect that ran AFTER the load check, leaving the
  // new file un-loadable on a switch.
  const lastLoadedPathRef = useRef<string | null>(null);
  const messages = getMessages(locale);

  // Hardcoded to 'kennedy' (drawio's default light theme) regardless of
  // whale's overall theme — the user wants drawio to always render in
  // light mode. The drawio embed has no live `setTheme` action, so the
  // only way to switch is to re-create the iframe with a new `ui=` URL
  // param, which would interrupt in-progress edits. Re-enable dark
  // follow by restoring the `whaleTheme === 'dark' ? 'dark' : 'kennedy'`
  // expression and re-adding `theme: whaleTheme` to the destructure above.
  const drawioTheme: DrawioTheme = 'kennedy';

  const handleChange = useCallback(() => {
    setDirty(true);
  }, [setDirty]);

  const handleError = useCallback((message: string) => {
    setError(message);
    // Also notify host so it can fall back to native app if needed.
    if (file?.path) {
      window.whaleExt.postMessage({ type: 'error', message, path: file.path });
    }
  }, [file]);

  // Forward drawio's cell-link clicks to the host. `openLinkExternally`
  // routes `http(s)://` URLs to `window.open` and everything else (notably
  // `file://`) to `ipcApi.openNative` → `shell.openPath`, so the user can
  // click a thumbnail to open its source file/folder in Whale/OS.
  const handleOpenLink = useCallback((href: string) => {
    window.whaleExt.postMessage({ type: 'openLinkExternally', url: href });
  }, []);

  const { iframeRef, bridge } = useDrawioBridge(
    handleChange,
    handleError,
    handleOpenLink
  );

  // Safety net: if drawio's embed never sends 'init' within 15s, show an
  // explicit error in the panel instead of an indefinite "Loading…".
  useEffect(() => {
    if (bridge.loaded || error) return;
    const t = window.setTimeout(() => setLoadTimedOut(true), 15000);
    return () => window.clearTimeout(t);
  }, [bridge.loaded, error]);

  // Load file content into draw.io when both draw.io is ready and file arrives.
  // `lastLoadedPathRef` guards against re-runs on subsequent re-renders —
  // without it, every re-render (where `bridge` ref may change) would
  // re-post the original `file.content` to drawio's `load` action, wiping
  // the cell the user just inserted via drag-drop. Keying on `file.path`
  // (not a boolean) means switching files A → B naturally re-loads B.
  useEffect(() => {
    if (!file || !bridge.loaded) return;
    if (lastLoadedPathRef.current === file.path) return;
    lastLoadedPathRef.current = file.path;
    const xml = file.content || '<mxfile></mxfile>';
    bridge.loadXml(xml);
    lastSavedRef.current = xml;
    setDirty(false);
  }, [file, bridge, setDirty]);

  // Theme is passed via `ui=...` in the URL when the iframe is created.
  // The drawio embed API has no `setTheme` action — calling it just
  // produces `unknownMessage` noise. A live theme switch would require
  // tearing down + re-creating the iframe (TODO: figure out a cleaner
  // path when we actually need dark-mode switching in drawio).
  // useEffect(() => { bridge.setTheme(drawioTheme); }, [bridge, drawioTheme]);

  // Handle host save request.
  useEffect(() => {
    onRequestSave(async () => {
      if (!file || pendingSaveRef.current) return;
      pendingSaveRef.current = true;
      try {
        const xml = await bridge.getXml();
        lastSavedRef.current = xml;
        save(xml);
      } catch (err) {
        handleError(err instanceof Error ? err.message : String(err));
      } finally {
        pendingSaveRef.current = false;
      }
    });
  }, [bridge, file, handleError, onRequestSave, save]);

  // Clear dirty state when host confirms save.
  useEffect(() => {
    if (!file) return;
    const off = window.whaleExt.onMessage((msg) => {
      if (msg.type === 'savingFile' && msg.path === file.path) {
        setDirty(false);
        bridge.setModified(false);
      }
    });
    return off;
  }, [bridge, file, setDirty]);

  // External-drag overlay lifecycle. The host fires `externalDrag {active:true}`
  // on dragstart. A matching `active:false` arrives from the host's window
  // dragend listener (ExtensionHost.tsx) — even if the drop landed on a
  // dead zone (toolbar, sidebar, wrapper edge) where the overlay's drop
  // handler never fired. Without that signal the overlay would only clear
  // via the safety timer, which is the freeze the user reported.
//
// We deliberately do NOT clear `externalDragRef` on `active:false`: a
// drop-on-overlay fires `active:false` immediately AFTER requestFileEmbed
// has been posted, and fileEmbed (which clears the ref) arrives later. If
// we cleared the ref here, the subsequent fileEmbed would early-return
// and the cell wouldn't be inserted. Stale refs are harmless — the next
// `active:true` overwrites them, and unmount drops them.
//
// 5 s safety timer is a backstop for the rare case where `active:false`
// never arrives (e.g. drag cancelled by Chromium before reaching window).
  useEffect(() => {
    const off = window.whaleExt.onMessage((msg) => {
      if (msg.type !== 'externalDrag') return;
      if (msg.active) {
        setIsExternalDragging(true);
        if (dragTimerRef.current) window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = window.setTimeout(() => {
          setIsExternalDragging(false);
          clearExternalDrag();
          dragTimerRef.current = null;
        }, 5000);
      } else {
        setIsExternalDragging(false);
        if (dragTimerRef.current) {
          window.clearTimeout(dragTimerRef.current);
          dragTimerRef.current = null;
        }
        // Intentionally NOT calling clearExternalDrag() here — see comment
        // above. The 5 s safety timer would have already cleared it.
      }
    });
    return () => {
      off();
      if (dragTimerRef.current) window.clearTimeout(dragTimerRef.current);
    };
  }, [clearExternalDrag, externalDragRef]);

  // Watcher: force-update the outer overlay's inline style as a
  // belt-and-suspenders fix for the rare case where React's reconciliation
  // hasn't applied the new style prop yet by the time the user takes a
  // screenshot. The inner-iframe drawio highlight (the real source of the
  // "residual orange frame" the user reported) is handled by the next
  // useEffect, not this one — see the comment there.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = overlayRef.current;
    if (el) {
      // Use setProperty with explicit 'important' priority — inline style
      // with !important outranks external CSS !important, so this wins
      // even if the editor.css rule fails to load (e.g. cached iframe).
      el.style.setProperty(
        'display',
        isExternalDragging ? 'flex' : 'none',
        'important'
      );
      el.style.setProperty(
        'pointer-events',
        isExternalDragging ? 'auto' : 'none',
        'important'
      );
    }
  }, [isExternalDragging]);

  // Eject drawio's own drop highlight when our overlay is about to take
  // over. drawio's `EditorUi.prototype.highlightElement` (in
  // drawio-assets/js/app.min.js) creates a `3px dotted rgb(254, 137, 12)`
  // div on the FIRST `dragover` it sees and only removes it on
  // `dragleave` / `drop`. The flow that left a residual orange frame:
  //
  //   T1 user drags over the iframe → drawio's dragover handler appends
  //      the highlight div to the graph container
  //   T2 main renderer posts `externalDrag {active:true}` → React state
  //      flip → outer overlay becomes display:flex, pointer-events:auto
  //   T3 outer overlay now sits on top of the iframe; subsequent
  //      mouse-move / drop / dragleave events go to the overlay, never
  //      reach the iframe's content document
  //   T4 drawio's `var d` still points at the highlight div → never
  //      gets the dragleave that would call `d.parentNode.removeChild(d)`
  //
  // The previous watcher above only flipped the OUTER overlay's display,
  // not the iframe's contentDocument — so `display:none !important` on
  // the parent had no effect on the descendant iframe's children.
  //
  // Fix: on every isExternalDragging transition, walk the iframe's
  // document and remove any leftover highlight div. The selector matches
  // drawio's own inline-style string (`border:3px dotted rgb(254, 137, 12)`,
  // `position:absolute`, `pointer-events:none`). Runs on BOTH transitions:
  //   false→true: clears the highlight that drawio created during the
  //               brief window between T1 and T2
  //   true→false: safety net in case the user dropped on a dead zone
  //               (toolbar edge, etc.) and a new highlight slipped in
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const leftover = doc.querySelectorAll(
      'div[style*="dotted"][style*="254, 137, 12"]'
    );
    leftover.forEach((el) => {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }, [isExternalDragging]);

  // Apply the embedded thumbnail + link cell once the host answers with a
  // `fileEmbed` envelope. The bridge does a `getXml → append → loadXml`
  // round-trip internally (drawio's embed protocol has no per-cell insert
  // action), so all we need to do is hand it a unique cell id and the
  // drop position. `uniqueCellId` lives in `drop-xml.ts` so the format is
  // testable independently.
  //
  // Cell shape depends on whether the dragged item is an image (we have a
  // real bitmap thumbnail — render it as an mxImage cell) or a non-image
  // file/folder (the host still generated a thumbnail or generic icon, but
  // the user wants a labeled rectangle, not a tiny icon-as-image).
  //
  // Overlay clearing runs FIRST, unconditionally — if `drag` is null (e.g.
  // the active:false arrived before fileEmbed and didn't clear the ref,
  // but a previous fileEmbed did) we still want the overlay to disappear
  // when the host finishes talking to us. A previous version did this
  // AFTER the drag-null early-return, leaving the overlay stuck whenever
  // the ref was missing.
  // Read an image's natural pixel dimensions from its data URL. Async because
// it relies on `Image.onload` — the browser has to actually decode the bytes
// to know `naturalWidth` / `naturalHeight`. Used to size the inserted cell
// at the original image's aspect ratio (capped at MAX_SIDE px on the
// longer edge so a 6000×4000 photo doesn't blow up the drawio document).
async function getImageDataUrlDimensions(
  dataUrl: string
): Promise<{ width: number; height: number } | null> {
  if (!/^data:image\//.test(dataUrl)) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

useEffect(() => {
    const off = window.whaleExt.onMessage(async (msg) => {
      if (msg.type !== 'fileEmbed') return;
      // Always clear overlay state, regardless of whether we can insert.
      // (see isExternalDragging watcher above — we also force the DOM
      // update via overlayRef to bypass React reconciliation timing.)
      setIsExternalDragging(false);
      if (dragTimerRef.current) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }
      const drag = externalDragRef.current;
      if (!drag) {
        return;
      }
      const cellKind: 'image' | 'labeled' = drag.isImage ? 'image' : 'labeled';
      const { x, y } = nextDropPosition(dropIndexRef.current);
      dropIndexRef.current += 1;
      clearExternalDrag();

      // For image cells, size the cell at the original image's aspect
      // ratio (capped at MAX_SIDE px on the longer edge). The cell style
      // has `aspect=fixed;imageAspect=0` so drawio letterboxes if the
      // cell aspect doesn't match the image's; matching them up front
      // avoids the black bars.
      let width: number | undefined;
      let height: number | undefined;
      const MAX_SIDE = 400;
      if (cellKind === 'image') {
        const dims = await getImageDataUrlDimensions(msg.thumbnailDataUrl);
        if (dims && dims.width > 0 && dims.height > 0) {
          const scale = Math.min(
            1,
            MAX_SIDE / Math.max(dims.width, dims.height)
          );
          width = Math.max(40, Math.round(dims.width * scale));
          height = Math.max(40, Math.round(dims.height * scale));
        }
      }

      void bridge
        .insertLinkedThumbnail({
          filePath: drag.path,
          name: drag.name || msg.name,
          thumbnailDataUrl: msg.thumbnailDataUrl,
          cellId: uniqueCellId(cellKind === 'image' ? 'img' : 'lbl'),
          x,
          y,
          cellKind,
          width,
          height,
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[drawio] insertLinkedThumbnail threw:', err);
        });
      setDirty(true);
    });
    return off;
  }, [bridge, clearExternalDrag, externalDragRef, setDirty]);

  const handleDropOverlay = useCallback(
    (e: React.DragEvent) => {
      // Always preventDefault on dragover so the browser allows the drop.
      // (Drops that don't carry a matching externalDrag are ignored — we
      // can't extract a path from a native OS drag inside the sandbox.)
      e.preventDefault();
      e.stopPropagation();
      const drag = externalDragRef.current;
      if (!drag) return;
      // Ask the host for a thumbnail; the `fileEmbed` handler above does
      // the merge once the answer arrives.
      requestFileEmbed(drag.path, drag.isDirectory);
    },
    [externalDragRef, requestFileEmbed]
  );

  const handleDragOverOverlay = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // NOTE: there used to be a window-level `dragend` listener here that tried
  // to clear the overlay if the user released outside the iframe. It was
  // dead code — `dragend` fires on the source element (in the main
  // renderer) and doesn't propagate to the extension's child document, so
  // the listener never fired. The real fix lives in ExtensionHost.tsx as
  // a window-level dragend listener in the MAIN renderer, which posts
  // `externalDrag {active:false}` to this iframe via postMessage. The
  // externalDrag listener above handles that signal.

  const url = file
    ? getDrawioUrl(drawioTheme, readOnly, locale)
    : getDrawioUrl(drawioTheme, false, locale);

  if (error) {
    return (
      <div className="drawio-wrapper" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div>{messages.loadError}</div>
        <div style={{ fontSize: 12, marginTop: 8, opacity: 0.7 }}>{error}</div>
      </div>
    );
  }

  return (
    <div className="drawio-wrapper">
      {!bridge.loaded && !loadTimedOut && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
          }}
        >
          {messages.loading}
        </div>
      )}
      {loadTimedOut && !error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
            flexDirection: 'column',
            padding: 16,
            textAlign: 'center',
          }}
        >
          <div>{messages.loadError}</div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className="drawio-iframe"
        title="Draw.io"
        src={url}
      />
      {/* Always-mounted drop overlay — toggles pointer-events instead of
          conditional rendering. React render delay between dragstart and
          overlay mount is what previously let fast drags land on drawio's
          inner iframe (triggering `EditorUi.importFile` on non-XML files
          and freezing the editor). With the container always present,
          pointer-events flips synchronously inside the dragstart handler's
          postMessage round-trip — drops that arrive before drawio's inner
          iframe is ready still hit this overlay. */}
      <div
        ref={overlayRef}
        className="drawio-drop-overlay"
        aria-hidden={!isExternalDragging}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          border: '2px dashed rgba(240, 135, 5, 0.7)',
          borderRadius: 4,
          background: 'rgba(240, 135, 5, 0.06)',
          display: isExternalDragging ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#f08705',
          fontWeight: 600,
          // pointerEvents: 'none' when not dragging so the overlay never
          // blocks drawio's click handlers. Toggled to 'auto' on dragstart.
          pointerEvents: isExternalDragging ? 'auto' : 'none',
        }}
        onDragOver={handleDragOverOverlay}
        onDrop={handleDropOverlay}
      >
        <span style={{ background: 'rgba(255,255,255,0.85)', padding: '6px 12px', borderRadius: 4 }}>
          {messages.dropHint}
        </span>
      </div>
    </div>
  );
}