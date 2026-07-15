import path from 'path';
import { createWriteStream, statSync } from 'fs';
import * as fsp from 'fs/promises';
import os from 'os';
// Mapique map tiles require remote img-src in CSP (see index.html + below).
import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import windowStateKeeper from 'electron-window-state';
import { registerIpcHandlers } from './ipc';
import { registerAiCoreHandlers, maybeRegisterAiRuntimeHandlers } from './ai/ipc-ai-core';
// P0-2: index utilityProcess lifecycle hook. The worker is lazy-spawned on
// first IPC request and torn down here on app quit (best-effort kill;
// graceful shutdown with WAL flush is a follow-up).
import { killIndexWorker } from './index-worker-host';
import { buildMenu } from './menu';
import { assertWithinAllowedRoot, getAllowedRoots } from './allowed-roots';
import { mediaConvertSemaphore } from './concurrency';
import { runMigration } from './migrate-date-tags';
import { decodeWhaleAudioUrl, decodeWhaleFileUrl } from '../shared/whale-file-url';
import { createFileRangeResponse } from './protocol-range';
import { spawnTranscodeStream } from './audio-convert';
import { isTranscodeCached, transcodePathFor } from './transcode-cache';
import {
  resolveExtensionRequest,
  mimeForPath,
} from './extension-protocol';

/**
 * `process.env.NODE_ENV` is replaced at webpack build time:
 *  - 'development'  -> loads the renderer dev server (http://localhost:4002)
 *  - 'production'   -> loads the packaged renderer (file://)
 */
const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER_URL = 'http://localhost:4002';

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let closingMainWindow: BrowserWindow | null = null;
let closeFallback: NodeJS.Timeout | null = null;

function createWindow(): void {
  // Persist & restore window size/position across launches.
  const windowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800,
  });

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'WhaleTag',
    // Frameless: the renderer draws its own dark title bar (logo + min/max/close).
    // autoHideMenuBar keeps the menu registered (Windows Ctrl+C/V etc. rely on
    // it) but hides the white native menu bar until Alt is pressed.
    frame: false,
    autoHideMenuBar: true,
    // Dev mode runs the unpackaged Electron binary, which has no embedded icon —
    // point the taskbar/Alt-Tab/window icon at the project logo so the brand
    // shows up instead of Electron's default. Packaged builds inherit the icon
    // embedded in the exe and skip this.
    icon: isDev
      ? path.join(__dirname, '..', '..', '..', '..', 'resources', 'logo.png')
      : undefined,
    backgroundColor: '#0f0f10', // dark — avoids a white flash before the renderer paints
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload only uses the `electron` module (contextBridge/ipcRenderer),
      // so it runs fine under the sandbox — no Node surface exposed to it.
      sandbox: true,
    },
  });

  windowState.manage(mainWindow);

  // Push maximize/unmaximize to the renderer so the title bar's toggle button
  // can swap its icon to match the actual window state.
  const sendMaximizeState = (maximized: boolean): void => {
    mainWindow?.webContents.send('window:maximizeChange', maximized);
  };
  mainWindow.on('maximize', () => sendMaximizeState(true));
  mainWindow.on('unmaximize', () => sendMaximizeState(false));

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Open external http(s) links in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Graceful shutdown: ask the renderer to flush redux-persist before the
  // window (and therefore the renderer process) is destroyed. The storage
  // adapter writes synchronously in the main process, so the flush guarantees
  // the latest state is on disk before the app exits.
  //
  // Graceful shutdown: ask the renderer to flush redux-persist before the
  // window (and therefore the renderer process) is destroyed. The storage
  // adapter writes synchronously in the main process, so the flush guarantees
  // the latest state is on disk before the app exits.
  mainWindow.on('close', (event) => {
    const win = mainWindow;
    if (!win) return;

    // If we are already in the middle of a graceful close, keep preventing the
    // default so a second close signal (impatient second click, Alt+F4 repeat,
    // etc.) doesn't bypass the flush path.
    if (isQuitting) {
      event.preventDefault();
      return;
    }

    isQuitting = true;
    event.preventDefault();
    closingMainWindow = win;
    win.webContents.send('app:request-flush');
    closeFallback = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.log('[main] flush fallback timeout');
      finishMainWindowClose();
    }, 3000);
  });

  // Belt-and-suspenders: if the window is destroyed without going through our
  // graceful path (e.g. a forced OS close), make sure our bookkeeping is reset.
  mainWindow.on('closed', () => {
    // eslint-disable-next-line no-console
    console.log('[main] main window closed');
    if (mainWindow && (mainWindow.isDestroyed() || closingMainWindow === mainWindow)) {
      mainWindow = null;
    }
    closingMainWindow = null;
    isQuitting = false;
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // main.js lives in dist/main/, renderer is a sibling dir dist/renderer/.
    mainWindow.loadFile(
      path.resolve(__dirname, '..', 'renderer', 'index.html')
    );
  }
}

/**
 * Locks down what the renderer is allowed to load. Dev permits the webpack dev
 * server (+ its HMR websocket / eval); production is strict 'self'. Styles stay
 * 'unsafe-inline' because MUI/emotion inject runtime styles. Images/fonts allow
 * data:/blob: (file icons, generated previews). object-src allows blob: so the
 * sandboxed PDF viewer extension can embed a native PDF renderer.
 */
function configureCsp(): void {
  const directives = [
    "default-src 'self'",
    isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:4002 whale-extension://*"
      : "script-src 'self' whale-extension://*",
    "style-src 'self' 'unsafe-inline' blob: whale-extension://*",
    // Map tiles (Mapique) are loaded as <img> from OSM or a user-configured
    // tile server, so allow remote http(s) image sources here.
    "img-src 'self' data: blob: https: http: whale-extension://* whale-file://*",
    "media-src 'self' blob: whale-extension://* whale-file://* whale-audio://*",
    "font-src 'self' data: blob: whale-extension://*",
    "frame-src 'self' data: blob: whale-extension://*",
    isDev
      ? "connect-src 'self' http://localhost:4002 ws://localhost:4002 whale-extension: whale-file: data: blob:"
      : "connect-src 'self' whale-extension: whale-file: data: blob:",
    "worker-src 'self' blob: whale-extension://*",
    "object-src 'self' blob:",
    "base-uri 'self'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Each extension ships its own meta CSP (see src/extensions/*/index.html).
    // The main-process directives are too strict for third-party webapps
    // bundled in extensions: drawio, for example, needs 'unsafe-inline' /
    // 'unsafe-eval' in script-src and external connect-src, and its inner
    // iframe is loaded via the same whale-extension:// origin. Skipping the
    // main-process CSP here lets the extension's own policy govern, while
    // the ExtensionHost sandbox attribute still bounds the damage surface.
    if (details.url.startsWith('whale-extension://')) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [directives],
      },
    });
  });
}

function bootstrap(): void {
  Menu.setApplicationMenu(buildMenu());
  registerIpcHandlers();
  registerAiCoreHandlers();
  // Register the SDK-backed AI runtime handlers iff the optional AI component
  // is installed (user-installed .whaleai → <userData>/components/ai). Core
  // handlers — keys, CLI discovery, component install/state — always register.
  void maybeRegisterAiRuntimeHandlers();

  // Phase 4 (§8): one-shot migration of legacy smart-tag storage form
  // (`today-20251223` → `20251223` etc.) across every allowed location.
  // Background fire-and-forget: never blocks startup, never throws — the
  // result is logged for diagnostics. The migration is idempotent so it's
  // safe to run on every boot (subsequent runs find nothing to do and
  // skip the backup-once flag write).
  void runMigration(getAllowedRoots())
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log(
        `[migrate-date-tags] scanned=${res.totalScanned} ` +
          `migrated=${res.totalMigrated} backups=${res.totalBackups} ` +
          `errors=${res.totalErrors}`
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[migrate-date-tags] unexpected error', err);
    });

  // Renderer has finished flushing redux-persist; finish closing the window.
  // The storage adapter now writes synchronously in the main process, so no
  // additional Chromium storage flush is required.
  ipcMain.on('app:flush-complete', () => {
    if (closeFallback) {
      clearTimeout(closeFallback);
      closeFallback = null;
    }
    finishMainWindowClose();
  });

  // Dev/testing helper: lets an automated script ask the main process to close
  // the window so the graceful shutdown + storage flush path is exercised.
  ipcMain.on('app:request-quit', () => {
    mainWindow?.close();
  });

  configureCsp();
  registerExtensionProtocol();
  registerWhaleFileProtocol();
  registerWhaleAudioProtocol();
  createWindow();

  // P0-2: tear down the index utilityProcess on quit. Best-effort kill —
  // a graceful `shutdown` op with a WAL checkpoint would be safer but is
  // deferred. The host's pending requests are rejected via the `exit`
  // handler in `index-worker-host.ts`; if the OS reaps the process before
  // `kill()` completes, those promises are also rejected. Also kill any live
  // audio transcode so ffmpeg doesn't outlive the app (on Windows it would
  // keep the cache `.tmp` handle locked).
  app.on('before-quit', () => {
    killIndexWorker();
    killAllAudioTranscodes();
  });

  // ABI/availability probe for the bundled ffmpeg (video thumbnails). Logged
  // once so a missing/locked binary is visible. Lazy-imported so ffmpeg-static
  // isn't pulled into the startup critical path — it backs only this diagnostic.
  void import('ffmpeg-static')
    .then(({ default: p }) => {
      // eslint-disable-next-line no-console
      console.log(
        p
          ? `FFMPEG_ELECTRON_OK ${p}`
          : 'FFMPEG_ELECTRON_MISSING (video thumbnails disabled)'
      );
    })
    .catch(() => {
      // eslint-disable-next-line no-console
      console.log('FFMPEG_ELECTRON_MISSING (video thumbnails disabled)');
    });

  // macOS: re-create a window when the dock icon is clicked with no windows open.
  // macOS: re-create a window when the dock icon is clicked with no windows open.
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
  });
}

/**
 * Finish tearing down the main window.
 */
function finishMainWindowClose(): void {
  if (!closingMainWindow) {
    // Nothing to do — the window was already closed by another path.
    isQuitting = false;
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[main] finishMainWindowClose destroyed=${closingMainWindow.isDestroyed()}`);

  if (!closingMainWindow.isDestroyed()) {
    closingMainWindow.destroy();
  }
  if (mainWindow === closingMainWindow) {
    mainWindow = null;
  }
  closingMainWindow = null;
  isQuitting = false;
}

/**
 * Tell Chromium to treat `whale-extension://` as a real origin (standard +
 * secure). Without this, documents served by `registerFileProtocol` get an
 * opaque origin, which blocks `document.cookie` reads and several other APIs
 * that extension webapps (drawio, excalidraw, ebook-viewer, etc.) depend on.
 *
 * MUST be called before `app.whenReady()` resolves — Electron only inspects
 * the privilege list once at startup.
 *
 * `supportFetchAPI` is deliberately NOT set: in this Electron build, enabling
 * it still yields "Failed to fetch" for `whale-extension://` resources (the
 * scheme is fetchable in theory but the response is rejected in practice), so
 * it buys nothing and adds cross-cutting behavioral risk. Extensions that need
 * bytes from their bundled assets fetch them through the host instead — see
 * the `ext:getPdfAsset` / `ext:getCadWasm` IPC bridges (the extension requests
 * the bytes over postMessage, the main process reads them via `fsp` and
 * returns an ArrayBuffer). Excalidraw's handwritten-font / locale fetches
 * therefore still degrade to system fonts (known limitation, §七).
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'whale-extension',
    privileges: {
      standard: true,
      secure: true,
    },
  },
  {
    // Stream files into the renderer for the media lightbox (B2 fix).
    // Same privilege shape as `whale-extension://` so the renderer sees a
    // real origin and the CSP entries below can reference it.
    scheme: 'whale-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    // Live Opus transcode of audio Chromium can't decode (APE/WMA/AIFF/…).
    // ffmpeg stdout is piped straight to `<audio>` so playback starts on the
    // first Ogg page instead of after the whole file is transcoded. Byte-
    // identical privileges to `whale-file` — `stream: true` is REQUIRED or
    // Chromium buffers the entire Response body before delivering any byte.
    scheme: 'whale-audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

/**
 * Pin `app.getPath('userData')` to the product-name root BEFORE the app is
 * ready. Without this, `electron.exe path/to/main.js` (the way the
 * `electron` CLI bin and `npm start` ultimately spawn it) makes
 * `app.getName()` fall back to the literal string "Electron" and carves a
 * fresh `%APPDATA%/Electron/` next to the real `%APPDATA%/WhaleTag/`. That
 * silently splits user state across two roots — settings changed in one
 * launch never reappear in the next, because each run reads from a
 * different directory. `app.setName` after `whenReady` does not unstick
 * the cached userData path, so we set it explicitly here. Must run
 * before any code path that calls `app.getPath('userData')` — notably
 * `persist-storage.ts` on its first read/write.
 */
function pinUserDataToProductName(): void {
  const productName = 'WhaleTag';
  let resolved: string;
  if (process.platform === 'win32') {
    resolved = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      productName
    );
  } else if (process.platform === 'darwin') {
    resolved = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      productName
    );
  } else {
    resolved = path.join(os.homedir(), '.config', productName);
  }
  app.setPath('userData', resolved);
  app.setName(productName);
}

pinUserDataToProductName();

// Last-line-of-defense loggers. The whale-file protocol handler is the only
// known offender so far, but the same bug class (an async error escaping
// `protocol.handle`'s try/catch and bubbling up as an unhandled promise
// rejection that takes the renderer down with a "WhaleTag encountered an
// error" dialog) could show up in any future async handler. Catching and
// logging them keeps a regression visible to whoever's watching the dev
// console instead of silently killing the app.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(
    '[main] unhandledRejection:',
    reason instanceof Error ? `${reason.stack ?? reason.message}` : reason
  );
});

app.whenReady().then(bootstrap);

// Quit when all windows are closed, except on macOS (apps stay active).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Registers a custom file protocol so extension iframes can load their
 * index.html and assets from a stable URL in both dev and production.
 * `whale-extension://text-editor/index.html` resolves to the packaged
 * `dist/extensions/text-editor/index.html`.
 *
 * Implementation note — Electron 32+ migration:
 * The previous implementation used the deprecated
 * `protocol.registerFileProtocol` callback API. That API silently fails to
 * serve when the scheme is registered as a privileged custom scheme
 * (`standard: true, secure: true` — see `registerSchemesAsPrivileged`
 * above), so the iframe body never executes and the host never receives
 * the extension's `ready` handshake. The sibling `whale-file` protocol
 * already uses the modern `protocol.handle` API (see
 * `registerWhaleFileProtocol` below); this function is migrated to match.
 *
 * The actual resolution + read logic is factored into
 * `resolveExtensionRequest` so it can be unit-tested without spinning up
 * an Electron runtime (see `extension-protocol.test.ts`). This handler
 * just wraps the helper in a `Response`.
 */
function registerExtensionProtocol(): void {
  // In production, `__dirname` is the bundled main.js folder
  // (release/app/dist/main); the extensions live one level up.
  const extensionsRoot = path.resolve(__dirname, '..', 'extensions');
  protocol.handle('whale-extension', async (request) => {
    const result = await resolveExtensionRequest(request.url, extensionsRoot);
    if (result.ok) {
      // `Buffer` is a Node-specific subclass of `Uint8Array`; DOM `Response`
      // accepts `Uint8Array` directly. Wrap the Buffer in a fresh
      // Uint8Array view (no copy) so the type checker is happy and the
      // underlying ArrayBuffer is shared.
      const body = new Uint8Array(
        result.buf.buffer,
        result.buf.byteOffset,
        result.buf.byteLength
      );
      return new Response(body as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': result.mime,
          'Cache-Control': 'no-cache',
        },
      });
    }
    // Discriminated by `result.ok === false` in the type union.
    return new Response((result as { msg: string; status: number }).msg, {
      status: (result as { msg: string; status: number }).status,
    });
  });
}

/**
 * Streaming file protocol for the media lightbox (B2 fix).
 *
 * URLs take the form `whale-file:///<encoded-absolute-path>` (note the empty
 * hostname — the path itself is the payload). The handler streams the file
 * with Range support so the browser can scrub and load metadata without
 * buffering the whole file — the only way to open multi-GB videos without
 * OOM'ing the renderer.
 *
 * Security: the resolved path must sit under one of the configured location
 * roots (same guard as write-side operations in allowed-roots.ts, including
 * symlink resolution). The Range math + Node→Web stream adaptation live in
 * `protocol-range.ts` (`createFileRangeResponse`) so the same path is shared
 * by `whale-audio://`'s cache-hit branch.
 */
function registerWhaleFileProtocol(): void {
  protocol.handle('whale-file', async (request) => {
    try {
      const filePath = decodeWhaleFileUrl(request.url);
      if (!filePath) {
        return new Response('Malformed whale-file URL', { status: 400 });
      }
      // Confine to configured locations — refuse if no roots, refuse if the
      // target isn't under any root. Symlink resolution happens inside the
      // guard via `realpath`, so a symlink pointing outside also gets rejected.
      assertWithinAllowedRoot(filePath);
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return new Response('Not a regular file', { status: 404 });
      }
      const headers = new Headers({
        'Content-Type': mimeForPath(filePath),
        'Cache-Control': 'no-cache',
      });
      return createFileRangeResponse(filePath, request, headers);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Status code is the only signal the renderer gets before the stream
      // opens; pick 403 for "outside allowed roots" and 404 otherwise.
      const status = msg.startsWith('Refused') ? 403 : 404;
      return new Response(msg, { status });
    }
  });
}

/**
 * Live Opus transcode protocol for audio formats Chromium can't decode
 * (APE / WMA / AIFF / …). Solves the "large APE album rip takes minutes to
 * start playing" problem: Opus-in-Ogg is a streaming-first container, so we
 * pipe ffmpeg's stdout straight to `<audio>` and playback begins on the
 * first Ogg page instead of after the whole file is transcoded.
 *
 * Two paths:
 *  - Cache hit (`.whale/transcodes/<basename>.opus` fresh, mtime ≥ source):
 *    serve the complete file with Range/206 via `createFileRangeResponse` —
 *    instant start + full seekability (same as `whale-file`).
 *  - Cache miss: spawn ffmpeg → Ogg/Opus on stdout, tee it to the `<audio>`
 *    Response (live, no `Content-Length`) AND to `<cache>.tmp`, which is
 *    renamed to the final cache path only on a clean ffmpeg exit. So the
 *    first open plays within ~1s AND warms a seekable cache for next time.
 *
 * Concurrency: the inflight `Map` dedups same-source requests (a 2nd listener
 * awaits the running transcode, then serves the cache). The semaphore bounds
 * total ffmpeg/ebook/cad children. A `Set` of live children is killed on
 * `before-quit` so a long transcode never outlives the app (Windows would
 * otherwise keep the cache `.tmp` handle locked).
 *
 * Security: identical to `whale-file` — `assertWithinAllowedRoot` on the
 * decoded SOURCE path; the cache path lives under the same root so it's
 * transitively covered.
 */
const activeAudioTranscodes = new Map<string, Promise<void>>();
const liveAudioChildren = new Set<import('child_process').ChildProcess>();

function registerWhaleAudioProtocol(): void {
  protocol.handle('whale-audio', async (request) => {
    try {
      const filePath = decodeWhaleAudioUrl(request.url);
      if (!filePath) {
        return new Response('Malformed whale-audio URL', { status: 400 });
      }
      assertWithinAllowedRoot(filePath);

      const baseHeaders = new Headers({
        // `audio/opus` matches what media-player's MIME_MAP + the old blob
        // path used; Chromium plays Ogg/Opus under this MIME. Same header for
        // the live stream and the cache-hit file so the browser treats them
        // identically.
        'Content-Type': 'audio/opus',
        'Cache-Control': 'no-cache',
      });

      // Cache hit → serve seekable Opus file (Range/206).
      const cached = await isTranscodeCached(filePath);
      if (cached.fresh) {
        return createFileRangeResponse(cached.path, request, baseHeaders);
      }

      // Another request is already transcoding this exact source — wait for
      // it to finish writing the cache, then serve the now-complete file.
      // v1: the second listener does NOT get instant-start; teeing one ffmpeg
      // stdout to N web streams is a follow-up.
      const inflight = activeAudioTranscodes.get(filePath);
      if (inflight) {
        await inflight.catch(() => undefined);
        const recheck = await isTranscodeCached(filePath);
        if (recheck.fresh) {
          return createFileRangeResponse(recheck.path, request, baseHeaders);
        }
        // producer failed → fall through and try a fresh transcode
      }

      return await streamAudioTranscode(filePath, request, baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.startsWith('Refused') ? 403 : 500;
      return new Response(msg, { status });
    }
  });
}

/**
 * Spawn ffmpeg for `filePath`, tee its Ogg/Opus stdout to (1) a live
 * `<audio>` Response and (2) a `<cache>.tmp` write stream, and return the
 * Response. Owns the ffmpeg lifecycle: stderr drain, 5-min SIGKILL timeout,
 * cache rename on clean exit / tmp cleanup on failure, semaphore release,
 * and inflight resolution. Registers the child in `liveAudioChildren` for
 * app-quit teardown.
 */
async function streamAudioTranscode(
  filePath: string,
  request: Request,
  baseHeaders: Headers
): Promise<Response> {
  // Register as in-flight SYNCHRONOUSLY (before the first await) so a
  // concurrent same-source request sees us and waits instead of starting a
  // second ffmpeg. JS is single-threaded: no other request can interleave
  // between this Map.set and the awaits below.
  let resolveInflight!: () => void;
  let rejectInflight!: (err: Error) => void;
  const inflight = new Promise<void>((resolve, reject) => {
    resolveInflight = resolve;
    rejectInflight = reject;
  });
  activeAudioTranscodes.set(filePath, inflight);

  await mediaConvertSemaphore.acquire();
  const cachePath = transcodePathFor(filePath);
  const tmpPath = `${cachePath}.tmp`;
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });

  const { child, stdout } = spawnTranscodeStream(filePath);
  if (!stdout) {
    mediaConvertSemaphore.release();
    activeAudioTranscodes.delete(filePath);
    throw new Error('ffmpeg produced no stdout stream');
  }
  liveAudioChildren.add(child);

  // Capture stderr for a useful error message. Draining it is also REQUIRED:
  // an undrained stderr pipe fills its OS buffer (~64KB) and ffmpeg blocks
  // forever on write(stderr).
  let stderrText = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderrText += b.toString('utf8').slice(-2048);
  });

  const cacheWrite = createWriteStream(tmpPath);
  // 5-min SIGKILL bound (spawn ignores the `timeout` option). Matches the old
  // buffer path's ceiling. Cleared on a clean finish.
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);

  // Handle to the web-stream controller, set synchronously inside the
  // ReadableStream's `start()` (which runs during `new ReadableStream()`).
  // Declared here so `finish()` (below) can drive the stream to its terminal
  // state from any event handler — they all fire after `start()` has run.
  const controllerRef: {
    current: ReadableStreamDefaultController<Uint8Array> | null;
  } = { current: null };

  let finished = false;
  const finish = (err?: Error): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    liveAudioChildren.delete(child);
    mediaConvertSemaphore.release();
    if (err) {
      cacheWrite.destroy();
      void fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      rejectInflight(err);
    } else {
      // Flush + publish the cache atomically: only rename after the write
      // stream has finished, so a half-written file is never visible.
      cacheWrite.end(() => {
        fsp
          .rename(tmpPath, cachePath)
          .then(() => resolveInflight())
          .catch(() => rejectInflight(new Error('failed to finalize transcode cache')));
      });
    }
    // Drive the web stream to its terminal state. The double-close guard
    // (`finished`) means a later `cancel()` / `child close` is a no-op —
    // same race that crashed the renderer in the `whale-file` path.
    const controller = controllerRef.current;
    if (controller) {
      try {
        if (err) {
          controller.error(err);
        } else {
          controller.close();
        }
      } catch {
        /* controller already terminal */
      }
    }
    activeAudioTranscodes.delete(filePath);
  };

  // Node → Web ReadableStream: tee stdout to the controller (browser) AND the
  // cache write stream. One copy per chunk detaches it from Node's reused
  // pool buffer (both the controller queue and the async fs write outlive the
  // 'data' listener, so the original pool view would be overwritten). The
  // write stream's backpressure propagates to ffmpeg via stdout.pause/resume.
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef.current = controller;
      stdout.on('data', (chunk: Buffer) => {
        if (finished) return;
        // Copy the chunk off Node's reused stdout pool buffer — both the
        // controller queue and the async fs write outlive this 'data'
        // listener, so the original pool view would be overwritten by the
        // next emission. ArrayBuffer.slice copies; Buffer.from(ArrayBuffer)
        // is a view over that fresh copy (nothing else mutates it). Mirrors
        // the whale-file adapter in protocol-range.ts.
        const buf = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength
        );
        const copy = Buffer.from(buf);
        try {
          controller.enqueue(new Uint8Array(buf));
        } catch (enqueueErr) {
          finish(enqueueErr instanceof Error ? enqueueErr : new Error(String(enqueueErr)));
          return;
        }
        if (!cacheWrite.write(copy)) {
          stdout.pause();
          cacheWrite.once('drain', () => stdout.resume());
        }
      });
      stdout.on('error', (err) => finish(err));
      child.on('error', (err) => finish(err)); // spawn ENOENT etc.
      // child 'close' fires after stdio drains + process exits — the source
      // of truth for "transcode done". code 0 = success; anything else is a
      // failure (partial Opus stream + must NOT be cached).
      child.on('close', (code, signal) => {
        if (code === 0 && signal == null) {
          finish();
        } else {
          finish(
            new Error(
              `ffmpeg exited code=${code} signal=${signal ?? 'null'}${stderrText ? `: ${stderrText.trim()}` : ''}`
            )
          );
        }
      });
    },
    cancel() {
      finish(new Error('client cancelled transcode stream'));
    },
  });

  // Hand back the live Response. No Content-Length, no Accept-Ranges: the
  // browser plays the chunked Ogg/Opus as it arrives. Seeking on this first
  // (uncached) play is not supported — restored once the cache completes.
  return new Response(webStream, { status: 200, headers: baseHeaders });
}

/**
 * Kill every live audio transcode child. Called on `before-quit` so a long
 * ffmpeg doesn't outlive the app (on Windows it would keep the cache `.tmp`
 * handle locked, blocking cleanup).
 */
function killAllAudioTranscodes(): void {
  for (const child of liveAudioChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
  liveAudioChildren.clear();
}
