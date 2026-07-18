# Application auto-update (electron-updater + GitHub Releases)

Phase 6 of the plan adds an end-to-end auto-update flow backed by
[`electron-updater`](https://www.electron.build/auto-update) and the
public [FE-Berserker/WhaleTag](https://github.com/FE-Berserker/WhaleTag)
GitHub release channel. This document is the single source of truth for
how the pieces fit; the source comments in `src/main/auto-update.ts`
are kept terse and defer to here for the "why".

## TL;DR

- **Channel:** GitHub Releases on `FE-Berserker/WhaleTag` (the
  `latest` release, semver greater than `package.json#version`).
- **Trigger:** a 5-second-delayed silent check on startup, plus a
  manual "Check for updates" button in **Settings → About / Updates**.
  The user controls the silent check via `autoUpdateCheck` (default
  on); the manual button is always available.
- **Download:** explicit user action — the renderer subscribes to
  `app:update-progress` and shows a determinate `LinearProgress`.
  `electron-updater` does *not* auto-download / auto-install.
- **Install:** "Restart to install" button calls `appQuitAndInstall()`,
  which terminates the running app and runs the OS installer on exit.
- **Dev mode:** every IPC handler short-circuits with
  `{ kind: 'unsupported' }` — there's no `app-update.yml` outside a
  packaged build, so the wire-level error is explicit instead of a
  silent `electron-updater` failure.

## Build / publish chain (already in place)

The build side was set up before this PR landed:

- `resources/builder.json` has a `publish` segment
  (`provider: 'github'`, `owner: 'FE-Berserker'`, `repo: 'WhaleTag'`,
  `releaseType: 'release'`) — added in this PR.
- `electron-builder` produces `release/build/latest.yml` (a semver +
  `sha512` + `path` manifest) and `release/build/win-unpacked/resources/
  app-update.yml` (the `provider: github` channel config) per build.
  These were already present in the repo as build artifacts; this PR
  was the first to wire the *client* to read them.

To publish a new version:

1. Bump `package.json#version` (semver).
2. `npm run build && npm run package:win` (or `:mac` / `:linux`).
3. `electron-builder` will auto-upload the artifacts to the GitHub
   release named with the version tag. **Caveat:** this assumes the
   release exists on GitHub first — see "Release workflow" below.

### Release workflow (manual today)

`electron-builder`'s `publish` config *generates* the manifest, but
**does not create the GitHub release itself.** Current practice: tag
+ push first, then run `package:win` to attach artifacts. The PR
author runs:

```bash
git tag v0.3.2 && git push --tags
npm run package:win
```

`electron-builder` then uploads `WhaleTag-Setup-0.3.2.exe` +
`latest.yml` to the existing `v0.3.2` release. End-users running an
older build see the manifest change on the next startup check.

> Automating this (e.g. via `gh release create --generate-notes`) is
> a follow-up; not in scope here.

## Wire shape

The renderer talks to the main process through `window.whale` — the
existing `contextBridge` surface. Four new methods + one new event
subscriber:

```ts
// main process (auto-update.ts) → renderer (UpdateSection.tsx)
ipcMain.handle('app:update-check',           () => checkForUpdates());
ipcMain.handle('app:update-download',        () => downloadUpdate());
ipcMain.on('app:update-quit-and-install',    () => quitAndInstall());

// push channels (subscribe in main, fan out via webContents.send)
'app:update-available'  → AppUpdateInfo
'app:update-progress'   → { percent, bytesPerSecond, transferred, total }
'app:update-downloaded' → AppUpdateInfo
'app:update-error'      → string
```

Wire types live in `src/shared/ipc-types.ts`
(`AppUpdateInfo`, `AppUpdateCheckResult`, `AppUpdateDownloadResult`,
`AppUpdateProgressPayload`). The renderer's `UpdateSection.tsx` keeps a
small `ViewState` union that maps onto the user's mental model: idle
→ checking → available → downloading → downloaded → restart.

## Lifecycle

```
+----------------------+      main: whenReady
| (process start)      |      initAutoUpdater()
+----------------------+      wireAutoUpdaterEvents()
        |                      ↓
        |    5 s delay (if !app.isPackaged → skip)
        ↓                      ↓
+----------------------+   scheduleStartupCheck()
| (renderer boot)      |   fires one silent check
+----------------------+   if available → 'available' push
        |                      ↓
        ↓                      ↓
   UpdateSection listens; "Check for updates" button always available
        |                      ↓
        ↓              (if user opts in via UI)
        ↓              ipcRenderer.invoke('app:update-download')
        ↓              autoUpdater.downloadUpdate()
        ↓                      ↓
        ↓              'progress' pushes 0..100
        ↓              'downloaded' once ready
        ↓                      ↓
        ↓              "Restart to install" button
        ↓              ipcRenderer.send('app:update-quit-and-install')
        ↓              autoUpdater.quitAndInstall()
        ↓                      ↓
+----------------------+      app quits → OS installer runs
```

The startup-delayed check uses an `unref()`-ed `setTimeout(5_000)`
(see `auto-update.ts:scheduleStartupCheck`); it does not delay app
startup and is cleared automatically if the process exits before the
timer fires.

## Dev-mode short-circuit

`app.isPackaged` is `false` under `npm run dev`. Every public function
in `auto-update.ts` checks this and short-circuits:

- `checkForUpdates()` → `{ kind: 'unsupported' }`
- `downloadUpdate()` → `{ kind: 'error', error: 'unsupported' }`
- `quitAndInstall()` → no-op
- `scheduleStartupCheck()` → no-op (timer not scheduled)

The renderer surfaces `unsupported` as "Auto-update is unavailable in
development builds" so unit tests, `npm run dev` sessions, and the
"Run from source" path don't hit a confusing "no updates found" or a
stack trace.

## macOS / Linux status

- **Windows (NSIS):** full path. `autoUpdater` reads `app-update.yml`
  from `<install-dir>/resources/`, downloads the new NSIS exe, runs
  the new installer on `quitAndInstall()`. The user sees the standard
  NSIS dialog during install.
- **macOS (DMG):** blocked on Apple notarization (see `docs/16` §hard
  block). The renderer is fully wired; the *publish* step needs the
  notarized DMG to exist on the GitHub release. We document this
  explicitly so the missing piece is visible to whoever sets up CI.
- **Linux (AppImage):** `electron-updater` supports AppImage but the
  cross-platform doc (`docs/16`) lists it as "needs a Linux
  maintainer". Same as macOS — code is in place, the build pipeline
  is the gating dependency.

## Security considerations

- **Channel integrity:** the manifest (`latest.yml`) is fetched over
  HTTPS and `sha512`-verified by `electron-updater` before the
  download is used. Tampering with the manifest is detectable.
- **Code signing:** Windows NSIS builds are **not code-signed** in
  the current pipeline (also flagged in `docs/16` §hard block).
  Windows will show an "Unknown publisher" SmartScreen warning on
  first install of a new version. Update flow itself is unaffected;
  users who clicked through once will not see the warning on
  subsequent updates.
- **No silent install:** `autoDownload` and `autoInstallOnAppQuit`
  are both explicitly set to `false`. The user must click "Restart
  to install" to upgrade. This trades a small delay (the user
  restarts the app later) for the explicit gate every security
  review asks for.

## Open follow-ups (not in this PR)

- **Release automation:** tag-driven `gh release create` script that
  runs `package:*` after the release exists, so the upload step
  doesn't require a human to be at the keyboard.
- **macOS notarization:** unblock the full macOS update path
  (currently a hard block in `docs/16`).
- **Linux AppImage:** needs a Linux build host + smoke test before
  we can promise auto-update on Linux.
- **Migrating from auto-updater to something user-hostable:** the
  current design depends on GitHub Releases being reachable from
  every user's machine. Behind the GFW this can be slow. A future
  iteration could mirror the manifest to a CDN or a self-hosted
  artifact store; the `setFeedURL` call is the only seam.

## See also

- `docs/01-architecture.md` §B — three-process model + window.whale
  bridge (the IPC plumbing this feature rides on).
- `docs/14-packaging.md` — the build pipeline that produces the
  manifests this module consumes.
- `docs/16-cross-platform.md` §hard block — macOS notarization,
  Linux maintainer gap.
- `src/main/auto-update.ts` — the main-side state machine.
- `src/renderer/components/UpdateSection.tsx` — the renderer UI.
