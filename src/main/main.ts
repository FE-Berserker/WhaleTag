import path from 'path';
import { statSync } from 'fs';
import os from 'os';
// Mapique map tiles require remote img-src in CSP (see index.html + below).
import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import windowStateKeeper from 'electron-window-state';
import { registerIpcHandlers } from './ipc';
import { registerAiCoreHandlers, maybeRegisterAiRuntimeHandlers } from './ai/ipc-ai-core';
// P0-2: index utilityProcess lifecycle hook. The worker is lazy-spawned on
// first IPC request and torn down on app quit — graceful `shutdown` op first
// (WAL checkpoint), then best-effort kill.
import { killIndexWorker, shutdownIndexWorker, subscribe as subscribeIndexWorker } from './index-worker-host';
import { setDirChangedBroadcast, closeAllWatchers } from './dir-watcher';
// Thumbnail-render utilityProcess (pdf/ebook/font pure-JS CPU, docs/06 §8).
// Lazy-spawned on the first pdf/ebook/font thumbnail; torn down here on app
// quit (best-effort kill).
import { killThumbWorker } from './thumb-worker-host';
// P3-3: office→PDF persistent UNO worker. Lazy-spawned on the first office
// conversion; torn down here on app quit (kills the python worker AND its
// soffice listener grandchild via tree-kill).
import { killOfficeWorker } from './office-worker/office-worker-host';
// Phase 6: application auto-update via electron-updater + GitHub Releases.
// The IPC handlers + startup-delayed check + dev-mode short-circuit all
// live in this module. See docs/18-auto-update.md for the full flow.
import {
  initAutoUpdater,
  scheduleStartupCheck,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  subscribe as subscribeAutoUpdate,
} from './auto-update';
import { buildMenu } from './menu';
import { assertWithinAllowedRoot } from './allowed-roots';
import { getWhaleAppVersion } from './app-version';
import { decodeWhaleFileUrl } from '../shared/whale-file-url';
import { createFileRangeResponse } from './protocol-range';
import { registerWhaleAudioProtocol, killAllAudioTranscodes } from './whale-audio-protocol';
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

// Console logging must never crash the app. In dev, Electron's stdio is a
// pipe owned by the spawning tool (electronmon / concurrently); once that
// parent dies — routine with accumulated dev instances (docs/01 §8) — any
// `console.*` write raises EPIPE as an *uncaught* exception (seen in the
// field as a Mapique crash from extractGps' per-file console.debug,
// docs/09 §27). Swallow EPIPE on both streams: a GUI app losing log output
// beats crashing.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

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

/**
 * Register IPC channels for application auto-update. Each `webContents.send`
 * broadcast targets the channel the renderer is listening on
 * (`onAppUpdateEvent`). The renderer is responsible for surfacing UI; main
 * just normalises the wire shape and keeps a single source of truth in
 * `auto-update.ts`.
 *
 * Concurrency: `checkForUpdates()` dedupes itself in `auto-update.ts`; the
 * download / quit channels are idempotent.
 */
function registerAutoUpdateHandlers(): void {
  // App metadata — not auto-update, but the same `app:` channel family, so it
  // rides along here. Used by Settings → About. Read from the real
  // package.json (not Electron's `app.getVersion()` which can report the
  // Electron runtime version when the app is launched via a script path).
  ipcMain.handle('app:getVersion', () => getWhaleAppVersion());
  ipcMain.handle('app:update-check', () => checkForUpdates());
  ipcMain.handle('app:update-download', () => downloadUpdate());
  ipcMain.on('app:update-quit-and-install', () => quitAndInstall());

  // Bridge the in-process subscriber Set to the per-window push channel.
  // `auto-update.ts` already calls `subscribe()` on its own events; we
  // forward every event payload to all live BrowserWindows.
  subscribeAutoUpdate('available', (info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:update-available', info);
    }
  });
  subscribeAutoUpdate('progress', (p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:update-progress', p);
    }
  });
  subscribeAutoUpdate('downloaded', (info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:update-downloaded', info);
    }
  });
  subscribeAutoUpdate('error', (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:update-error', msg);
    }
  });
}

function bootstrap(): void {
  Menu.setApplicationMenu(buildMenu());
  registerIpcHandlers();
  registerAiCoreHandlers();
  // docs/04 §10: forward index-worker build progress to the renderer
  // (SearchBar's index build + Settings → Full-text builds). Broadcast to
  // every window like the auto-update events above; consumers filter by
  // rootPath.
  subscribeIndexWorker((ev) => {
    if (ev.kind !== 'progress') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('index:progress', ev);
    }
  });
  // docs/04 §10: fs.watch flushes → renderer (`fs:dirChanged`), same
  // broadcast shape as the index progress above.
  setDirChangedBroadcast((ev) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('fs:dirChanged', ev);
    }
  });
  // Register the SDK-backed AI runtime handlers iff the optional AI component
  // is installed (user-installed .whaleai → <userData>/components/ai). Core
  // handlers — keys, CLI discovery, component install/state — always register.
  void maybeRegisterAiRuntimeHandlers();
  // Application auto-update (electron-updater + GitHub Releases). Wire the
  // `electron-updater` event bus into our local listener Set; the IPC
  // handlers below (app:update-check / app:update-download / etc.) and the
  // startup-delayed check piggyback on this. See docs/18-auto-update.md.
  initAutoUpdater();
  registerAutoUpdateHandlers();
  scheduleStartupCheck();

  // Phase 4 date-tag migration is NOT launched here: it is triggered by the
  // first non-empty `fs:setAllowedRoots` push (see ipc.ts) — at bootstrap the
  // renderer hasn't mounted yet, so the root set would always be empty and
  // the migration would silently no-op (docs/09 §26).

  // Renderer has finished flushing redux-persist; finish closing the window.
  // The storage adapter is async (invoke), so this handshake drains in-flight
  // persist writes before the window is destroyed — it must stay.
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

  // P0-2: tear down the index utilityProcess on quit. Graceful first:
  // `shutdownIndexWorker()` asks the worker to closeAllDbs (WAL checkpoints
  // into the main db file, no `-wal` residue), bounded by a 1s timeout so a
  // stuck worker can never hang the quit; then the usual best-effort kills
  // run (pending requests are rejected via the host's `exit` handler; if the
  // OS reaps the process first, those promises are also rejected). The
  // two-pass guard: preventDefault on the first `before-quit`, then
  // `app.quit()` again once teardown finished. Also kill any live audio
  // transcode so ffmpeg doesn't outlive the app (on Windows it would keep
  // the cache `.tmp` handle locked).
  let quitTeardownDone = false;
  app.on('before-quit', (event) => {
    if (quitTeardownDone) return; // second pass — our own app.quit() below
    event.preventDefault();
    quitTeardownDone = true;
    void shutdownIndexWorker().finally(() => {
      try {
        killIndexWorker();
        // Thumbnail-render utilityProcess (pdf/ebook/font); best-effort kill.
        killThumbWorker();
        killAllAudioTranscodes();
        // P3-3: persistent office→PDF UNO worker + its soffice listener grandchild.
        killOfficeWorker();
        // docs/04 §10: location fs.watch handles.
        closeAllWatchers();
      } finally {
        app.quit();
      }
    });
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

