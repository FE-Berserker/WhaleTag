import { app, BrowserWindow } from 'electron';
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater';
import { getWhaleAppVersion } from './app-version';
import type {
  AppUpdateCheckResult,
  AppUpdateInfo,
} from '../shared/ipc-types';

/**
 * Application auto-update via `electron-updater` + GitHub Releases.
 *
 * Wiring shape:
 *  - `main.ts` calls `initAutoUpdater()` once on `whenReady`. This wires
 *    `electron-updater`'s internal events into our local listener Set,
 *    which `main.ts`'s IPC handler then broadcasts to all renderer
 *    windows via `webContents.send`.
 *  - `scheduleStartupCheck()` is optional: it fires one silent check
 *    `delayMs` after `initAutoUpdater()` and only if the user has the
 *    `autoUpdateCheck` setting enabled (Settings → About). The manual
 *    button in Settings always works regardless of the flag.
 *  - Dev-mode (`!app.isPackaged`): every IPC handler short-circuits with
 *    `{ kind: 'unsupported' }`. There's no `app-update.yml` to read,
 *    so `electron-updater` would silently fail anyway — we make the
 *    failure mode explicit so the renderer's UI can show "not available
 *    in dev builds" instead of a confusing spinner.
 *
 * We disable `autoDownload` + `autoInstallOnAppQuit` so the renderer —
 * not the updater — drives user-visible decisions. The renderer asks
 * the user first, then triggers `appDownloadUpdate()` and finally
 * `appQuitAndInstall()`. See `docs/18-auto-update.md` for the full
 * flow + the GitHub Releases publish chain.
 */

const GITHUB_OWNER = 'FE-Berserker';
const GITHUB_REPO = 'WhaleTag';

interface AppUpdateListener {
  available: Set<(info: AppUpdateInfo) => void>;
  progress: Set<(p: AppUpdateProgressPayload) => void>;
  downloaded: Set<(info: AppUpdateInfo) => void>;
  error: Set<(message: string) => void>;
}

interface AppUpdateProgressPayload {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

let _wired = false;
const _listeners: AppUpdateListener = {
  available: new Set(),
  progress: new Set(),
  downloaded: new Set(),
  error: new Set(),
};

// `electron-updater` fires `update-available` / `update-not-available`
// concurrently with the `checkForUpdates()` promise. We deduplicate the
// `available` channel so multiple subscribers stay consistent — the
// `available` payload is also delivered to the IPC caller as the
// `AppUpdateCheckResult` for the originating promise, so the wrapper
// helper dispatches once.
let _checkInFlight: Promise<AppUpdateCheckResult> | null = null;

/** Wire `electron-updater` events into our local subscriber Set. Idempotent. */
function wireAutoUpdaterEvents(): void {
  if (_wired) return;
  _wired = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    emit('available', normalizeInfo(info));
  });
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    emit('progress', {
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    emit('downloaded', normalizeInfo(info));
  });
  autoUpdater.on('error', (err: Error) => {
    emit('error', err instanceof Error ? err.message : String(err));
  });
}

function emit(
  channel: 'available' | 'progress' | 'downloaded' | 'error',
  data: AppUpdateInfo | AppUpdateProgressPayload | string
): void {
  // `_listeners[channel]` is a union of per-channel Set<callback> types that TS
  // can't narrow by `channel`, so assert through `unknown` to a Set of callbacks
  // that take this channel's payload. Runtime dispatch is correct because each
  // channel's listeners are registered with the matching signature (see
  // `subscribe`); this just satisfies the type-level correlation.
  const set = _listeners[channel] as unknown as Set<
    (payload: typeof data) => void
  >;
  for (const cb of set) {
    try {
      cb(data);
    } catch {
      // Don't let a renderer crash break the updater.
    }
  }
}

function normalizeInfo(info: UpdateInfo): AppUpdateInfo {
  const releaseNotes =
    typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes) &&
          info.releaseNotes.length > 0 &&
          typeof info.releaseNotes[0] === 'object' &&
          info.releaseNotes[0] !== null &&
          'note' in info.releaseNotes[0]
        ? String((info.releaseNotes[0] as { note: unknown }).note ?? '')
        : undefined;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes,
  };
}

/**
 * Initialise the auto-updater. Call once on `app.whenReady()`. Idempotent.
 * Disables auto-download + auto-install so the renderer drives the
 * user-visible flow (manual "Restart to install" gate). The feed URL is
 * hardcoded to the public GitHub release channel — overrides (e.g. an
 * internal testing channel) would live here.
 */
export function initAutoUpdater(): void {
  if (_wired) {
    // `init()` is safe to call repeatedly; just don't double-wire events.
  }
  wireAutoUpdaterEvents();

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
  });
  // Renderer-driven: no silent download, no background install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
}

/**
 * Run one update check; coerce the `electron-updater` promise into a
 * discriminated union that the renderer can switch on without losing
 * the install-relevant error message.
 *
 * Concurrent callers share one in-flight probe (mirrors the `_inflight`
 * pattern in `office-binary.ts:sofficeBinary`).
 */
export async function checkForUpdates(): Promise<AppUpdateCheckResult> {
  if (!app.isPackaged) {
    return { kind: 'unsupported' };
  }
  if (_checkInFlight) return _checkInFlight;

  _checkInFlight = (async (): Promise<AppUpdateCheckResult> => {
    try {
      const result = await autoUpdater.checkForUpdates();
      // `checkForUpdates()` resolves with `null` when no newer version is
      // available on the GitHub Releases channel; `updateInfo` is the
      // version we just polled. In both cases, fall back to current version.
      if (!result) {
        return {
          kind: 'no-update',
          current: getWhaleAppVersion(),
        };
      }
      const current = getWhaleAppVersion();
      if (current === result.updateInfo.version) {
        return { kind: 'no-update', current };
      }
      return {
        kind: 'update-available',
        info: normalizeInfo(result.updateInfo),
      };
    } catch (e) {
      return {
        kind: 'error',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  })();
  try {
    return await _checkInFlight;
  } finally {
    _checkInFlight = null;
  }
}

/**
 * Begin downloading the latest version detected by `checkForUpdates()`.
 * `electron-updater` deduplicates internally if the same version is
 * already in progress; we just translate errors.
 */
export async function downloadUpdate(): Promise<{
  kind: 'downloading' | 'error';
  error?: string;
}> {
  if (!app.isPackaged) {
    return { kind: 'error', error: 'unsupported' };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { kind: 'downloading' };
  } catch (e) {
    return {
      kind: 'error',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Quit immediately and let the updater run the installer on exit.
 * Renderer must gate this behind a "Restart to install" button.
 */
export function quitAndInstall(): void {
  if (!app.isPackaged) return;
  // `isSilent` defaults to `false` so the user sees the OS-level
  // installer progress (e.g. NSIS dialog). Renderer can override
  // later by re-exporting with `{ isSilent: true }` if needed.
  autoUpdater.quitAndInstall();
}

/** Render-side subscription. Returns the unsubscribe function. */
export function subscribe(
  channel: 'available' | 'progress' | 'downloaded' | 'error',
  callback:
    | ((info: AppUpdateInfo) => void)
    | ((p: AppUpdateProgressPayload) => void)
    | ((info: AppUpdateInfo) => void)
    | ((message: string) => void)
): () => void {
  // The Set is keyed by channel; cast the union-typed callback back to
  // the channel-correct shape so consumer types line up without `any`.
  const set = _listeners[channel] as Set<typeof callback>;
  set.add(callback);
  return () => set.delete(callback);
}

/**
 * Schedule a single silent check `delayMs` after init. Fires once; the
 * renderer can still trigger manual checks via `appCheckForUpdates()`.
 * Pass `enabled = false` (e.g. from a settings flag) to skip entirely.
 */
export function scheduleStartupCheck(
  delayMs = 5_000,
  enabled = true
): void {
  if (!enabled || !app.isPackaged) return;
  setTimeout(() => {
    void checkForUpdates();
    // The 'available' event handles the renderer notification when a
    // newer version is found — see wireAutoUpdaterEvents().
  }, delayMs).unref?.();
}

/**
 * Broadcast the most recent event payload to every BrowserWindow. The
 * IPC handler in `main.ts` calls this for each `webContents.send`.
 * Held here (rather than in main.ts) so the listeners and the broadcast
 * stay co-located with the rest of the auto-update state machine.
 */
export function broadcast(
  channel: 'app:update-available' | 'app:update-progress' | 'app:update-downloaded' | 'app:update-error',
  payload: AppUpdateInfo | AppUpdateProgressPayload | string
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}
