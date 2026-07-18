import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Dialog,
  IconButton,
  Tooltip,
  Typography,
  Stack,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

import type { DirEntry } from '../../shared/ipc-types';
import { isImageFile, isVideoFile } from '../../shared/whale-meta';
import { mediaPlaylist, wrapIndex } from '../domain/gallery';
import { encodeWhaleFileUrl } from '../../shared/whale-file-url';
import { ipcApi } from '-/services/ipc-api';

interface MediaLightboxProps {
  open: boolean;
  entries: DirEntry[];
  initialIndex: number;
  onClose: () => void;
  /**
   * P2-4: optional thumbnail cache used to render the bottom filmstrip.
   * Same map that's passed to GalleryView / Row — already populated for
   * any item the user has ever rendered as a thumbnail. Falls back to
   * file-type icons for items without a cached thumb.
   */
  thumbCache?: Map<string, string>;
}

/** Maps common image/video extensions to MIME types for blob URLs. */
function mimeTypeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    '3gp': 'video/3gpp',
  };
  return map[ext] || (isImageFile(name) ? 'image/jpeg' : 'video/mp4');
}

/**
 * Build a `whale-file://` URL for streaming playback. The main process
 * registers this scheme (see main.ts `registerWhaleFileProtocol`); it
 * streams the file with createReadStream + Content-Range so `<video>` can
 * scrub without buffering the whole file. The encoder/decoder pair lives
 * in `src/shared/whale-file-url.ts` — both ends import from there so
 * round-trip is guaranteed and `whale-file-url.test.ts` locks it down.
 */
function streamingUrlFor(filePath: string): string | null {
  return encodeWhaleFileUrl(filePath);
}

/**
 * Full-screen image/video lightbox with prev/next navigation and keyboard
 * shortcuts. The playlist is filtered to only image/video files from the
 * provided entries.
 *
 * B2 fix: videos no longer read the entire file into memory. They play
 * straight from `whale-file://` so multi-GB files scrub without OOM'ing the
 * renderer. Images keep the readFile→Blob path because they're small and
 * object URLs simplify memory cleanup via `revokedRef`.
 *
 * P1-3 (preload adjacent): when the user navigates to index N, the loader
 * also kicks off readFile→Blob for index N-1 and N+1 (images only — videos
 * stream instantly via whale-file://, no point preloading). On ←/→ the
 * current image is already a hot object URL, so there's no loading flash.
 *
 * P1-4 (immediate reclaim): URLs in the LRU window (current ± 1) are kept
 * alive; anything outside the window is `URL.revokeObjectURL`'d on the
 * next navigation. Previously all URLs survived until close/unmount, so
 * walking through a 100-image album accumulated 100 blobs in memory. Now
 * we cap steady-state at ~3 blobs (the visible image plus its neighbors).
 */
export default function MediaLightbox({
  open,
  entries,
  initialIndex,
  onClose,
  thumbCache,
}: MediaLightboxProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const playlist = useMemo(() => mediaPlaylist(entries), [entries]);
  const [index, setIndex] = useState(initialIndex);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P1-3/P1-4: path → blob URL LRU. Replaces the old `revokedRef` set that
  // survived until close/unmount. Now we prune on every navigation to keep
  // only the visible image and its ±1 neighbors in memory.
  const urlsByPathRef = useRef<Map<string, string>>(new Map());
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The currently-shown entry's path is a stable string; the load effect keys
  // off it (NOT the playlist array, which gets a fresh reference every render
  // and would otherwise cancel each in-flight read before it resolves).
  const current = playlist[index];
  const currentPath = current?.path;
  const isVideo = current ? isVideoFile(current.name) : false;

  // P1-4: revoke everything outside the current LRU window. Called after
  // preloads complete and whenever the index changes.
  const pruneOutsideWindow = useCallback(
    (keepPaths: Set<string>) => {
      const urls = urlsByPathRef.current;
      for (const [path, url] of urls) {
        if (!keepPaths.has(path)) {
          URL.revokeObjectURL(url);
          urls.delete(path);
        }
      }
    },
    []
  );

  // Reset state on close. Pruning the LRU also happens here so closing +
  // reopening the lightbox doesn't keep stale blobs around.
  useEffect(() => {
    if (open) {
      setIndex(initialIndex);
    } else {
      setObjectUrl(null);
      setError(null);
      for (const url of urlsByPathRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      urlsByPathRef.current.clear();
    }
  }, [open, initialIndex]);

  // P1-3: load current image (also kicks off preload of index±1 below).
  // Videos take the streaming path; nothing to buffer.
  useEffect(() => {
    if (!open || !currentPath) return;
    if (isVideo) {
      setObjectUrl(null);
      setLoading(false);
      setError(null);
      return;
    }
    // Synchronous cache hit (current image already preloaded as a neighbor):
    // skip the spinner entirely.
    const existing = urlsByPathRef.current.get(currentPath);
    if (existing) {
      setObjectUrl(existing);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const buf = await ipcApi.readFile(currentPath);
        if (cancelled) return;
        const blob = new Blob([buf], { type: mimeTypeOf(currentPath) });
        const url = URL.createObjectURL(blob);
        // P1-3/4 race guard: a concurrent preload may have stored this same
        // path while our readFile was in flight (the cache check at the top of
        // this effect is synchronous, done before the await). Revoke our
        // duplicate and surface the already-cached URL — overwriting would
        // orphan the first blob's object URL (the leak this fixes).
        const alreadyCached = urlsByPathRef.current.get(currentPath);
        if (alreadyCached) {
          URL.revokeObjectURL(url);
          setObjectUrl(alreadyCached);
          return;
        }
        urlsByPathRef.current.set(currentPath, url);
        setObjectUrl(url);
      } catch (e) {
        if (!cancelled) {
          setObjectUrl(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, currentPath, isVideo]);

  // P1-3: preload ±1 images. The cache-hit fast path in the load effect
  // above means navigation into a preloaded slot shows instantly (no
  // loading flash). We also queue a `pruneOutsideWindow` after a tick to
  // give the in-flight preloads time to land before we evict.
  useEffect(() => {
    if (!open) return;
    const keep = new Set<string>();
    for (const off of [-1, 0, 1]) {
      const i = index + off;
      if (i >= 0 && i < playlist.length) {
        const e = playlist[i];
        if (e) keep.add(e.path);
      }
    }
    // Kick off any missing neighbors (skip videos — streaming is instant).
    for (const path of keep) {
      if (urlsByPathRef.current.has(path)) continue;
      const entry = playlist.find((e) => e.path === path);
      if (!entry) continue;
      if (isVideoFile(entry.name)) continue;
      void (async () => {
        try {
          const buf = await ipcApi.readFile(path);
          const blob = new Blob([buf], { type: mimeTypeOf(path) });
          const url = URL.createObjectURL(blob);
          // Race: index may have moved while we were loading; bail out
          // before storing if so — otherwise we'd leak blobs into the LRU.
          if (!keep.has(path)) {
            URL.revokeObjectURL(url);
            return;
          }
          // P1-3/4 race guard: a concurrent load (load-current or another
          // preload) may have stored this path while our readFile was in
          // flight. Don't overwrite — that orphans the existing URL. Revoke
          // our duplicate; whichever load stored first wins.
          if (urlsByPathRef.current.has(path)) {
            URL.revokeObjectURL(url);
            return;
          }
          urlsByPathRef.current.set(path, url);
          // If this preload happens to land on the current slot, swap in.
          setObjectUrl((prev) => (path === currentPath ? url : prev));
        } catch {
          /* ignore — neighbor preload failures are non-fatal */
        }
      })();
    }
    // P1-4: prune URLs that fell outside the window. Defer one tick so
    // newly-preloaded neighbors can register before we evict.
    const t = window.setTimeout(() => pruneOutsideWindow(keep), 0);
    return () => window.clearTimeout(t);
  }, [open, index, playlist, currentPath, pruneOutsideWindow]);

  // Final cleanup on unmount (component truly going away, not just close).
  useEffect(() => {
    return () => {
      for (const url of urlsByPathRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      urlsByPathRef.current.clear();
    };
  }, []);

  const goPrev = useCallback(() => {
    setIndex((i) => wrapIndex(i - 1, playlist.length));
  }, [playlist.length]);

  const goNext = useCallback(() => {
    setIndex((i) => wrapIndex(i + 1, playlist.length));
  }, [playlist.length]);

  // P2-1: zoom + pan state for the image (videos are skipped — scrubbing is
  // already provided by the native <video controls>). Reset to fit (1) every
  // time the user navigates to a new item, so ←/→ always starts at the same
  // composition rather than carrying over a random zoom from the previous one.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [currentPath]);

  // Wheel zoom: capped at 0.5x (well below fit) and 8x. Each wheel notch
  // multiplies by 1.15 in or 1/1.15 out, clamped at the bounds.
  //
  // React's synthetic onWheel is passive by default — to call preventDefault
  // we have to attach via addEventListener with `passive: false`. Without
  // this, the page would scroll while the user tries to zoom the image.
  // The handler is keyed on `[isVideo, objectUrl]` so it re-binds when the
  // media changes (img element is replaced for each new image).
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return undefined;
    const wheel = (e: WheelEvent) => {
      // Videos don't zoom — the native <video controls> own the wheel.
      if (isVideo) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => Math.max(0.5, Math.min(8, z * factor)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [isVideo, objectUrl]);

  // Drag-to-pan: only active when zoomed in. Tracking starts on mouse-down
  // anywhere on the image (so the cursor doesn't have to be over a specific
  // pixel) and ends on mouse-up at the window level so a release outside
  // the image still terminates the gesture cleanly.
  const dragStateRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const handleImgMouseDown = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (zoom <= 1) return; // no pan at fit-zoom
      e.preventDefault();
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      const onMove = (ev: MouseEvent) => {
        const s = dragStateRef.current;
        if (!s) return;
        setPan({ x: s.panX + (ev.clientX - s.startX), y: s.panY + (ev.clientY - s.startY) });
      };
      const onUp = () => {
        dragStateRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [zoom, pan.x, pan.y]
  );

  // Double-click toggles between fit (1x) and 2x — a common photo-viewer
  // gesture. Reset pan to 0 because the new zoom re-centers the image.
  const handleImgDoubleClick = useCallback(() => {
    if (isVideo) return;
    setZoom((z) => (z > 1 ? 1 : 2));
    setPan({ x: 0, y: 0 });
  }, [isVideo]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If zoomed in, Esc first resets the view; a second Esc closes the
        // lightbox. Matches how Apple Preview and Photos behave — Escape
        // doesn't always mean "close", it means "step back".
        if (zoom !== 1) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
          return;
        }
        onClose();
      } else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === ' ') {
        // Space toggles play/pause when the current item is a video.
        const video = videoRef.current;
        if (video) {
          e.preventDefault();
          if (video.paused) void video.play();
          else video.pause();
        }
      } else if (e.key === '+' || e.key === '=') {
        // '+' / '=' zoom in, '-' / '_' zoom out (keyboard parity with wheel).
        if (!isVideo) setZoom((z) => Math.min(8, z * 1.25));
      } else if (e.key === '-' || e.key === '_') {
        if (!isVideo) setZoom((z) => Math.max(0.5, z / 1.25));
      } else if (e.key === '0') {
        // '0' resets to fit — matches the browser-default zoom-reset key.
        if (!isVideo) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, goPrev, goNext, zoom, isVideo]);

  if (!current) return null;

  // Encoder returns null only for relative/empty paths, which shouldn't
  // happen for files surfaced by `mediaPlaylist` (those come from
  // `listDirectory` and are always absolute). Treat the failure mode the
  // same as a video-load error so the user sees a message instead of a
  // broken `<video src="null">` element.
  const videoSrc = isVideo ? streamingUrlFor(currentPath ?? '') ?? undefined : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(0, 0, 0, 0.92)',
            color: 'common.white',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      {/* Top bar: filename + counter + zoom controls + close */}
      <Stack
        sx={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1,
          background:
            theme.palette.mode === 'dark'
              ? 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)'
              : 'linear-gradient(to bottom, rgba(0,0,0,0.4), transparent)',
        }}
      >
        <Typography variant="body2" sx={{ color: 'common.white' }} noWrap>
          {current.name} ({index + 1} / {playlist.length})
        </Typography>
        {/* P2-1: image-only zoom controls. Hidden for video because
            <video controls> already provides browser-native zoom/scrub and
            we don't want to compete with that UI. The percentage readout
            doubles as a reset hint — click resets via the icon button. */}
        {!isVideo && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip title={t('zoomOut')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
                  disabled={zoom <= 0.5}
                  sx={{ color: 'common.white' }}
                >
                  <ZoomOutIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography
              variant="caption"
              sx={{
                color: 'common.white',
                minWidth: 44,
                textAlign: 'center',
                fontVariantNumeric: 'tabular-nums',
                opacity: 0.9,
              }}
            >
              {Math.round(zoom * 100)}%
            </Typography>
            <Tooltip title={t('zoomIn')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
                  disabled={zoom >= 8}
                  sx={{ color: 'common.white' }}
                >
                  <ZoomInIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t('resetZoom')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
                  sx={{ color: 'common.white' }}
                >
                  <RestartAltIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}
        <Tooltip title={t('close')}>
          <IconButton onClick={onClose} sx={{ color: 'common.white' }}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Main media area */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Tooltip title={t('previous')}>
          <IconButton
            onClick={goPrev}
            sx={{
              position: 'absolute',
              left: 16,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'common.white',
              bgcolor: 'rgba(255,255,255,0.1)',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.2)' },
              zIndex: 1,
            }}
          >
            <ChevronLeftIcon />
          </IconButton>
        </Tooltip>

        <Box
          sx={{
            maxWidth: '90vw',
            maxHeight: '85vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {error ? (
            <Typography color="error.main">{error}</Typography>
          ) : isVideo && videoSrc ? (
            // B2 fix: stream straight from the file. The main process
            // serves `whale-file://` with Content-Length + Accept-Ranges:
            // bytes so the <video> element can scrub and seek.
            <video
              ref={videoRef}
              src={videoSrc}
              controls
              autoPlay
              preload="metadata"
              onError={() =>
                setError(t('lightboxVideoLoadFailed', { name: current.name }))
              }
              style={{ maxWidth: '100%', maxHeight: '85vh' }}
            />
          ) : loading || !objectUrl ? (
            <Typography color="common.white">{t('loading')}</Typography>
          ) : (
            // P2-1: transform-driven zoom + pan. transform-origin is
            // `center` so the image scales from its midpoint on double-click,
            // and `cursor: zoom-in` at fit invites the gesture. When zoomed
            // past 1, cursor switches to grab/grabbing for the drag-pan.
            <img
              ref={imgRef}
              src={objectUrl}
              alt={current.name}
              onDoubleClick={handleImgDoubleClick}
              onMouseDown={handleImgMouseDown}
              draggable={false}
              style={{
                maxWidth: '100%',
                maxHeight: '85vh',
                objectFit: 'contain',
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
                cursor: zoom > 1 ? 'grab' : 'zoom-in',
                userSelect: 'none',
                // `transition` keeps wheel zoom feeling smooth instead of
                // snapping on every notch. Disabled during drag so panning
                // doesn't smear behind the cursor.
                transition: dragStateRef.current ? 'none' : 'transform 0.1s ease-out',
              }}
            />
          )}
        </Box>

        <Tooltip title={t('next')}>
          <IconButton
            onClick={goNext}
            sx={{
              position: 'absolute',
              right: 16,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'common.white',
              bgcolor: 'rgba(255,255,255,0.1)',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.2)' },
              zIndex: 1,
            }}
          >
            <ChevronRightIcon />
          </IconButton>
        </Tooltip>
      </Box>

      {/* P2-4 filmstrip: bottom thumbnail bar that mirrors `playlist`. Click a
          thumbnail to jump to that item; the current item is highlighted.
          Hidden for very short playlists (≤3) since the prev/next buttons
          are sufficient and the strip would feel redundant. */}
      {playlist.length > 3 && (
        <LightboxFilmstrip
          playlist={playlist}
          currentIndex={index}
          thumbCache={thumbCache}
          onSelect={(i) => setIndex(i)}
        />
      )}
    </Dialog>
  );
}

/**
 * P2-4 subcomponent: horizontal filmstrip rendered at the bottom of the
 * lightbox. Each cell is a fixed-size thumbnail (48px) with a name label;
 * the current cell is highlighted with a primary outline so the user
 * always sees where they are in the playlist. The strip auto-scrolls
 * horizontally to keep the current item in view — implemented with
 * `scrollIntoView({ inline: 'center' })` on the active cell.
 *
 * We don't pull in the heavyweight `ThumbIcon` here (it owns an
 * IntersectionObserver + queue, overkill for a strip that's already
 * visible). For each cell we just look up the parent `thumbCache` by
 * `${path}|${modified}` (same key ThumbIcon uses) and render the data URL
 * as an `<img>`. If absent, fall back to a file-type icon so the strip
 * still gives a visual cue for every entry.
 */
function LightboxFilmstrip({
  playlist,
  currentIndex,
  thumbCache,
  onSelect,
}: {
  playlist: DirEntry[];
  currentIndex: number;
  thumbCache?: Map<string, string>;
  onSelect: (index: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Auto-scroll the active cell into view on index change. `inline: 'center'`
  // keeps the current item visually centered rather than hugging an edge,
  // which feels better when navigating via ←/→.
  useEffect(() => {
    const el = cellRefs.current[currentIndex];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [currentIndex]);

  return (
    <Box
      ref={stripRef}
      sx={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 88,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: '8px 16px',
        overflowX: 'auto',
        overflowY: 'hidden',
        // Match the top bar's gradient for visual symmetry.
        background:
          'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 70%, transparent 100%)',
        zIndex: 1,
        // Hide scrollbar visually but keep wheel-scroll accessible. The
        // MUI styled scrollbar would clash with the dark background.
        '&::-webkit-scrollbar': { height: 4 },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: 'rgba(255,255,255,0.3)',
          borderRadius: 2,
        },
      }}
    >
      {playlist.map((entry, i) => {
        const cacheKey = `${entry.path}|${entry.modified}`;
        const thumb = thumbCache?.get(cacheKey);
        const active = i === currentIndex;
        return (
          <Box
            key={entry.path}
            component="button"
            ref={(el: HTMLButtonElement | null) => {
              cellRefs.current[i] = el;
            }}
            type="button"
            onClick={() => onSelect(i)}
            title={entry.name}
            sx={{
              flex: '0 0 auto',
              width: 48,
              height: 48,
              padding: 0,
              border: 'none',
              borderRadius: 0.5,
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden',
              position: 'relative',
              // Active cell stands out with a 2px primary outline; hover
              // gives a subtler highlight so the user can preview click
              // targets before committing.
              outline: active ? '2px solid' : '2px solid transparent',
              outlineColor: active ? 'primary.main' : 'transparent',
              outlineOffset: 2,
              transition: 'outline-color 0.1s',
              '&:hover': { background: 'rgba(255,255,255,0.12)' },
            }}
          >
            {thumb ? (
              <img
                src={thumb}
                alt={entry.name}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
              />
            ) : (
              <Box
                sx={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'common.white',
                  fontSize: 18,
                  opacity: 0.7,
                }}
              >
                {isVideoFile(entry.name) ? '▶' : '🖼'}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
