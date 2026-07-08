import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appendSnippetToDiagram,
  buildFileDropSnippet,
  buildLabeledDropSnippet,
  buildSafeSingleCellDocument,
  decodeDrawioDiagram,
  type FileDropSnippetOptions,
} from './drop-xml';

export type DrawioTheme = 'kennedy' | 'min' | 'atlas' | 'dark' | 'sketch';

export interface DrawioMessage {
  event?: string;
  action?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface DrawioBridge {
  loaded: boolean;
  loadXml: (xml: string) => void;
  getXml: () => Promise<string>;
  setTheme: (theme: DrawioTheme) => void;
  setModified: (modified: boolean) => void;
  /** Insert a single cell whose image is the supplied thumbnail data URL and
   *  whose `<UserObject link=…>` wrapper points at `filePath`. Implemented
   *  as a `getXml → appendSnippet → loadXml` round-trip — the only embed
   *  mutation drawio exposes is `action: 'load'` (full replace); the
   *  `merge` action requires checksum handshaking for collaborative sync
   *  and rejects single-cell payloads, so we read-modify-write instead.
   *  The diagram briefly flickers (load replaces the whole document); this
   *  is acceptable for a drag-drop insert. Resolves once loadXml is posted. */
  insertLinkedThumbnail: (opts: FileDropSnippetOptions) => Promise<void>;
}

const DRAWIO_URL = './drawio-assets/index.html';

type QueueItem = {
  id: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
};

/**
 * Pure dispatcher for `message` events from the drawio embed. Extracted from
 * `useDrawioBridge` so it can be unit-tested without React. Returns the
 * resolved XML string when the event carries one (autosave / save / export),
 * or `null` if the event is something the bridge doesn't act on.
 *
 * `autosave` and `save` are drawio's own timer-driven events. `export` is
 * what the bridge's `getXml` triggers via the `action: 'export', format: 'xml'`
 * request — drawio replies with `{event: 'export', xml: '...', format: 'svg'}`.
 * Pre-fix the bridge only matched `autosave`/`save`, so the `getXml` queue
 * never resolved and the 5-second timeout fired with "draw.io save timeout".
 */
export function dispatchDrawioMessage(
  data: DrawioMessage
):
  | { kind: 'init' }
  | { kind: 'xml'; xml: string }
  | { kind: 'error'; message: string }
  | { kind: 'openLink'; href: string; target?: string }
  | null {
  if (data.event === 'init') {
    return { kind: 'init' };
  }
  if (
    data.event === 'autosave' ||
    data.event === 'save' ||
    data.event === 'export'
  ) {
    const xml = data.xml as string | undefined;
    if (xml) return { kind: 'xml', xml };
    return null;
  }
  if (data.event === 'error' || data.action === 'error') {
    return {
      kind: 'error',
      message: String(data.message ?? data.error ?? 'Draw.io error'),
    };
  }
  // Drawio emits `{event:'openLink', href, target, allowOpener}` when the
  // user clicks a cell whose `<UserObject link="…">` is set. We forward to
  // the host so file:// / whale-file:// links can be opened in Whale instead
  // of trying to navigate the sandboxed iframe (which the CSP disallows).
  if (data.event === 'openLink') {
    const href = typeof data.href === 'string' ? data.href : '';
    if (!href) return null;
    return {
      kind: 'openLink',
      href,
      target: typeof data.target === 'string' ? data.target : undefined,
    };
  }
  return null;
}

export function useDrawioBridge(
  onChange: () => void,
  onError: (message: string) => void,
  /** Drawio posts `{event:'openLink', href, target, allowOpener}` when the
   *  user clicks a cell whose `<UserObject link="…">` is set. The bridge
   *  has no knowledge of the host envelope protocol — `app.tsx` supplies
   *  this callback and routes through `window.whaleExt.postMessage`. */
  onOpenLink?: (href: string, target?: string) => void
): {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  bridge: DrawioBridge;
} {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const readyRef = useRef(false);
  const pendingXmlRef = useRef<string | null>(null);
  const pendingThemeRef = useRef<DrawioTheme | null>(null);
  const requestQueueRef = useRef<QueueItem[]>([]);

  const postToDrawio = useCallback((msg: DrawioMessage) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify(msg), '*');
  }, []);

  const loadXml = useCallback(
    (xml: string) => {
      if (!readyRef.current) {
        pendingXmlRef.current = xml;
        return;
      }
      postToDrawio({ action: 'load', xml });
    },
    [postToDrawio]
  );

  const getXml = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      requestQueueRef.current.push({ id, resolve, reject });
      // Draw.io autosave returns the current XML via event 'autosave' or 'save'.
      // We trigger a save/export to force it to emit XML back.
      postToDrawio({ action: 'export', format: 'xml', spin: 'Updating' });
      // Fallback: reject after timeout so callers don't hang.
      window.setTimeout(() => {
        const idx = requestQueueRef.current.findIndex((r) => r.id === id);
        if (idx >= 0) {
          requestQueueRef.current.splice(idx, 1);
          reject(new Error('draw.io save timeout'));
        }
      }, 5000);
    });
  }, [postToDrawio]);

  const setTheme = useCallback(
    (theme: DrawioTheme) => {
      if (!readyRef.current) {
        pendingThemeRef.current = theme;
        return;
      }
      postToDrawio({ action: 'setTheme', theme });
    },
    [postToDrawio]
  );

  const setModified = useCallback(
    (modified: boolean) => {
      postToDrawio({ action: 'modified', modified });
    },
    [postToDrawio]
  );

  // Insert one image cell with a hyperlink into the current diagram. Drawio's
  // embed API has no per-cell insertion action: `merge` is for collaborative
  // sync with checksum handshaking (rejects single-cell payloads), and
  // `remoteInvoke` only allows read-only functions for whitelisted domains.
  // So we round-trip: read the current XML (compressed wire format — see
  // `decodeDrawioDiagram`), decode → append the new cell to <root> →
  // reload the raw XML.
  //
  // CRITICAL: drawio's `load` action expects RAW uncompressed XML, not the
  // compressed wire format used by `autosave`/`save`/`export`. Sending
  // compressed XML to `load` makes drawio's `mxUtils.parseXml` choke on
  // the base64 stream, throws into `handleError`, and freezes the editor
  // (a previous version of this function re-encoded before sending —
  // that's the "drag into drawio freezes" bug).
  //
  // Also: an `insertInflightRef` guard prevents concurrent inserts from
  // racing — two parallel `getXml → loadXml` cycles would post conflicting
  // `load` actions to drawio, the second wiping the first's result. If a
  // second insert arrives while one is in flight, we resolve immediately
  // without sending anything to drawio (the first insert's loadXml will
  // land before the second's getXml starts anyway).
  const insertInflightRef = useRef(false);
  const insertLinkedThumbnail = useCallback(
    async (opts: FileDropSnippetOptions): Promise<void> => {
      if (insertInflightRef.current) {
        // A previous insert is still resolving. Skip to avoid a parallel
        // loadXml that would clobber the just-inserted cell.
        return;
      }
      insertInflightRef.current = true;
      const snippet =
        opts.cellKind === 'labeled'
          ? buildLabeledDropSnippet(opts)
          : buildFileDropSnippet(opts);

      // Preferred path: read the user's current diagram, decode drawio's
      // compressed wire format, splice the new cell into <root>, re-load
      // the raw uncompressed XML. Preserves the user's existing content.
      let targetXml: string | null = null;
      try {
        const compressed = await getXml();
        const decoded = decodeDrawioDiagram(compressed);
        if (decoded) {
          const appended = appendSnippetToDiagram(decoded, snippet);
          if (appended) targetXml = appended;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[drawio] decode/append failed, falling back:', err);
      }

      // Fallback: a fresh single-cell document with the full set of
      // mxGraphModel attributes drawio's UI needs to initialize cleanly.
      // Wipes the user's existing diagram but at least leaves drawio in a
      // good state instead of frozen on a malformed half-edit.
      if (targetXml === null) {
        targetXml = buildSafeSingleCellDocument(snippet);
      }

      try {
        loadXml(targetXml);
      } finally {
        insertInflightRef.current = false;
      }
    },
    [getXml, loadXml]
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;

      let data: DrawioMessage;
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      const result = dispatchDrawioMessage(data);
      if (result === null) {
        // `exit` and `status` events fall here — non-fatal, ignore.
        return;
      }

      if (result.kind === 'init') {
        // Drawio is ready. Do NOT echo {event:'init'} back — that's the legacy
        // "ready" string protocol; with proto=json drawio uses structured
        // messages and just expects us to start sending actions.
        readyRef.current = true;
        setLoaded(true);
        if (pendingThemeRef.current) {
          // Theme is already passed via `ui=...` in the URL; nothing to push.
          pendingThemeRef.current = null;
        }
        if (pendingXmlRef.current !== null) {
          loadXml(pendingXmlRef.current);
          pendingXmlRef.current = null;
        }
        return;
      }

      if (result.kind === 'xml') {
        // drawio's `export` action (which is what `getXml` posts) returns its
        // response as `{event: 'export', xml: '...'}` — see drawio
        // `createLoadMessage('export')` + the `export` action handler in
        // `installMessageHandler`. We accept all three event names so the
        // bridge works whether drawio is in autosave mode or we're
        // requesting XML on demand. Without this, the `getXml` queue never
        // resolves and the 5-second timeout fires with "draw.io save timeout".
        const queue = requestQueueRef.current;
        requestQueueRef.current = [];
        queue.forEach((r) => r.resolve(result.xml));
        onChange();
        return;
      }

      if (result.kind === 'error') {
        // eslint-disable-next-line no-console
        console.error('[drawio] drawio returned error:', result.message);
        onError(result.message);
        return;
      }

      if (result.kind === 'openLink') {
        // Drawio posts `{event:'openLink', href, target, allowOpener}` when
        // the user clicks a cell whose `<UserObject link="…">` is set.
        // Caller decides how to route (typically posts `openLinkExternally`
        // to the host so file:// URLs open in Whale instead of failing the
        // iframe's CSP navigation).
        onOpenLink?.(result.href, result.target);
        return;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [loadXml, onChange, onError, onOpenLink, postToDrawio, setTheme]);

  const bridge: DrawioBridge = useMemo(
    () => ({
      loaded,
      loadXml,
      getXml,
      setTheme,
      setModified,
      insertLinkedThumbnail,
    }),
    [loaded, loadXml, getXml, setTheme, setModified, insertLinkedThumbnail]
  );

  return { iframeRef, bridge };
}

export function getDrawioUrl(
  theme: DrawioTheme,
  readOnly: boolean,
  lang: string
): string {
  const params = new URLSearchParams({
    embed: '1',
    // proto=json switches drawio from its legacy "ready" string handshake
    // (window.opener/window.parent.postMessage('ready', '*')) to the
    // structured JSON protocol ({event:"init"}, {event:"autosave", ...})
    // that the bridge in this file parses.
    proto: 'json',
    ui: theme,
    spin: '1',
    modified: '0',
    saveAndExit: '0',
    noSaveBtn: '1',
    noExitBtn: '1',
    lang: lang.startsWith('zh') ? 'zh' : 'en',
  });
  if (readOnly) {
    params.set('chrome', '0');
  }
  return `${DRAWIO_URL}?${params.toString()}`;
}
