import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useSelector } from 'react-redux';

import { useBackgroundPlayer } from '-/hooks/BackgroundPlayerContextProvider';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useDirectoryContentContext } from '-/hooks/DirectoryContentContextProvider';
import { ipcApi } from '-/services/ipc-api';
import { useResolvedThemeMode } from '-/theme/useResolvedThemeMode';
import { RootState } from '-/reducers';
import { encodeWhaleFileUrl } from '../../shared/whale-file-url';
import {
  EXT_PROTOCOL_VERSION,
  isValidEnvelope,
  type ExtensionMessage,
  type HostMessage,
} from '../../shared/extension-types';
import type { DirEntry } from '../../shared/ipc-types';
import { isAudioFile } from '../../shared/whale-meta';

/**
 * Persistent 64px-tall audio dock anchored to the bottom of the main window.
 * Hosts a second `media-player` iframe loaded with `?mode=bar` so the same
 * playback logic drives both the fullscreen viewer and the dock — only the
 * DOM layout differs.
 *
 * The dock is intentionally minimal: it owns NO playback state itself.
 * `state.queue[currentIndex]` lives in BackgroundPlayerContext; this
 * component just translates that into the iframe's postMessage protocol:
 *  - on every `currentPath` change → push `fileContent` + `streamingUrl`
 *  - on every `queue` change → push `siblings` (used by prev/next)
 *  - on every theme/locale change → push `setTheme` / `setLocale`
 *  - on every directory change → resync `background.queue` to the new
 *    folder's audio so prev/next/list-loop walk the folder the user is
 *    actually looking at (not a stale snapshot from the right-click menu).
 *
 * Outbound messages from the iframe:
 *  - `requestFile` → navigate within the queue (prev/next/clicked row)
 *  - `requestStreamingUrl` / `requestAudioConvert` → handled locally and
 *    answered with the same envelope types the fullscreen viewer uses
 *  - `requestOpenInView` → promote current track to the active viewer
 *  - `requestHide` → collapse the dock (BackgroundPlayerContext.dismissed)
 */
const DOCK_HEIGHT = 64;

export default function BackgroundPlayerDock() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  // Mirror of media-player's volume / muted / playbackRate. We don't enforce
  // any local state — these are the values the iframe just told us about so
  // we can re-apply them after a `requestOpenInView` round-trip.
  const themeMode = useSelector((s: RootState) => s.settings.themeMode);
  // Resolve `'system'` / the 8 curated full-theme modes down to the concrete
  // `'light' | 'dark'` the iframe understands — the same resolver the
  // fullscreen viewer uses (MainLayout → ExtensionViewPanel). A naive
  // `themeMode === 'dark'` check would leave the dock stuck on light for
  // `'system'` (dark OS) and every curated dark theme (midnight-plum /
  // deep-ocean / forest-ink / high-contrast).
  const resolvedThemeMode = useResolvedThemeMode(themeMode);
  const locale = useSelector((s: RootState) => s.settings?.language ?? 'en');

  const background = useBackgroundPlayer();
  const { openWithExtension, registry } = useExtensionContext();
  const { entries } = useDirectoryContentContext();

  const postToExtension = useCallback((message: HostMessage) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { protocolVersion: EXT_PROTOCOL_VERSION, source: 'host', message },
      '*'
    );
  }, []);

  /** Resolve a path into a usable DirEntry. Prefer the active directory's
   *  entries (so we get the freshest `size` / `modified`); fall back to a
   *  stub built from the path when the file lives outside the current
   *  directory (queue was seeded from another folder). */
  const resolveEntry = useCallback(
    (path: string): DirEntry => {
      const live = entries.find((e) => e.path === path);
      if (live) return live;
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      const name = slash >= 0 ? path.slice(slash + 1) : path;
      const dot = name.lastIndexOf('.');
      const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
      return {
        name,
        path,
        isDirectory: false,
        isFile: true,
        size: 0,
        modified: '',
        extension,
      };
    },
    [entries]
  );

  // Push current track as `fileContent` whenever it changes. We don't have
  // the bytes — we hand the iframe the path; for native-playable audio +
  // video the iframe asks back via `requestStreamingUrl`, for transcode-only
  // formats it asks back via `requestAudioConvert`. Mirrors the existing
  // ExtensionContext.openWithExtension short-circuit (see
  // ExtensionContextProvider.tsx:160).
  useEffect(() => {
    if (!ready) return;
    if (!background.currentPath) return;
    postToExtension({
      type: 'fileContent',
      path: background.currentPath,
      content: '',
      encoding: 'base64',
      readOnly: true,
      size: 0,
    });
  }, [ready, background.currentPath, postToExtension]);

  // Sync the background queue to the FOLDER OF THE CURRENTLY-PLAYING TRACK
  // whenever the track changes. The dock reads `listDirectory` for that
  // folder and adopts its audio files as the navigation source, so prev/next
  // and list-loop walk the folder the playing file lives in (not a stale
  // snapshot from a right-click "play this folder" earlier).
  //
  // We intentionally do NOT use `currentDirectoryPath` (where the FileList
  // is looking) — the user expects dock navigation to follow the playing
  // track, not their browsing focus.
  useEffect(() => {
    const currentPath = background.currentPath;
    if (!currentPath) return;
    const slash = Math.max(
      currentPath.lastIndexOf('/'),
      currentPath.lastIndexOf('\\')
    );
    if (slash < 0) return; // path has no parent — nothing to list
    const folderPath = currentPath.slice(0, slash);
    let cancelled = false;
    ipcApi
      .listDirectory(folderPath)
      .then((children) => {
        if (cancelled) return;
        const audio = children
          .filter((c) => !c.isDirectory && isAudioFile(c.name))
          .map((c) => c.path);
        background.syncToDirectory(audio);
      })
      .catch(() => {
        // Folder gone or unreadable — leave the queue as-is so existing
        // playback keeps going. The user can still hit prev/next within
        // whatever's in the queue.
      });
    return () => {
      cancelled = true;
    };
  }, [background.currentPath]);

  // Push the queue as `siblings` so prev/next/list-loop within the dock works.
  // `background.queue` is now kept in sync with the playing track's folder
  // (see the effect above), so this is the right source for navigation.
  useEffect(() => {
    if (!ready) return;
    if (background.queue.length === 0) return;
    if (!background.currentPath) return;
    postToExtension({
      type: 'siblings',
      current: background.currentPath,
      paths: background.queue,
    });
  }, [ready, background.queue, background.currentPath, postToExtension]);

  // Theme + locale.
  useEffect(() => {
    if (!ready) return;
    postToExtension({ type: 'setTheme', theme: resolvedThemeMode });
  }, [resolvedThemeMode, ready, postToExtension]);
  useEffect(() => {
    if (!ready) return;
    postToExtension({ type: 'setLocale', locale });
  }, [locale, ready, postToExtension]);

  // Hand the iframe a directory-dialog hook so its "+ add folder" button works
  // without us needing to add a new postMessage type. (Not wired yet — the
  // first cut only exposes the playlist from right-click enqueue.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    function onMessage(event: MessageEvent) {
      if (event.source !== iframe.contentWindow) return;
      if (!isValidEnvelope<ExtensionMessage>(event.data, 'extension')) return;
      const msg = event.data.message;
      switch (msg.type) {
        case 'ready':
          setReady(true);
          break;
        case 'requestFile': {
          // media-player wants to jump to a sibling (prev/next/play-this-row).
          // Translate the path back to a queue index. Out-of-range = no-op.
          const idx = background.queue.indexOf(msg.path);
          if (idx >= 0) background.jumpTo(idx);
          break;
        }
        case 'requestStreamingUrl': {
          const url = encodeWhaleFileUrl(msg.path);
          postToExtension({
            type: 'streamingUrl',
            path: msg.path,
            url: url ?? '',
          });
          break;
        }
        case 'requestAudioConvert': {
          const { requestId, path: audioPath } = msg;
          ipcApi
            .convertAudio(audioPath)
            .then((data) =>
              postToExtension({
                type: 'audioConvertedContent',
                requestId,
                data,
              })
            )
            .catch((e) =>
              postToExtension({
                type: 'audioConvertedContent',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              })
            );
          break;
        }
        case 'requestOpenInView': {
          const manifest = registry?.extensions.find(
            (m) => m.id === 'media-player'
          );
          if (!manifest) break;
          const entry = resolveEntry(msg.path);
          openWithExtension(entry, manifest).catch(() => undefined);
          break;
        }
        case 'requestHide':
          background.hide();
          break;
        default:
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [background, postToExtension, registry, resolveEntry, openWithExtension]);

  return (
    <Box
      sx={{
        flex: '0 0 auto',
        height: DOCK_HEIGHT,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: (t) =>
          t.palette.mode === 'dark'
            ? 'rgba(13, 17, 23, 0.95)'
            : 'rgba(245, 245, 245, 0.95)',
        position: 'relative',
      }}
    >
      <iframe
        ref={iframeRef}
        title="Background Music"
        src="whale-extension://media-player/index.html?mode=bar"
        allow="fullscreen"
        sandbox="allow-same-origin allow-scripts allow-modals allow-downloads"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
        }}
      />
      {/* Hide button. Hosted here (not inside the iframe) so it's always
          reachable even before the iframe finishes booting, and so it can
          trigger the persisted `dismissed` flag in BackgroundPlayerContext. */}
      <Tooltip title="收起后台播放（队列保留）">
        <IconButton
          size="small"
          onClick={() => background.hide()}
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            opacity: 0.45,
            '&:hover': { opacity: 1 },
          }}
        >
          <CloseIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}