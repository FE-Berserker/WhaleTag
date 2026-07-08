import { useEffect, useRef, useState } from 'react';
import { Box, Skeleton } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import { useSelector } from 'react-redux';

import type { DirEntry } from '../../shared/ipc-types';
import { isOfficeFile, isThumbnailable } from '../../shared/whale-meta';
import type { RootState } from '-/reducers';
import { ipcApi } from '-/services/ipc-api';
import { enqueueThumbLoad, cancelThumbLoad } from '-/services/thumb-load-queue';
import FileTypeIcon from './FileTypeIcon';

/**
 * Renders a file's thumbnail (image/video/pdf/office files) or a folder/file
 * glyph at `size` px. Loads the thumbnail lazily on mount; the data URL is
 * cached in `thumbCache` (keyed by `${path}|${modified}`) so a cell re-mounting
 * during scroll doesn't re-read from disk.
 *
 * Shared by the list rows (small, 40px) and the grid cells (entrySize). The
 * cache is owned by the parent (`FileList`) and cleared on directory change.
 *
 * P0-1 / P0-6 (gallery + list/grid shared): the actual `loadThumbnail` /
 * `generateThumbnail` IPC is gated by an IntersectionObserver. Off-screen
 * thumbs don't issue IPC at all; thumbs that scroll into view run through
 * a shared FIFO queue capped at 4 concurrent loads (see
 * `thumb-load-queue.ts`). Result on a 10k-entry directory: opening it shows
 * skeleton placeholders for off-screen cells, then fills them in as the
 * user scrolls (or pre-fills a viewport-margin lookahead so the visible
 * area appears instantly). No more "freeze for 5s on mount".
 */
export default function ThumbIcon({
  entry,
  thumbCache,
  size,
  rounded = 6,
  objectFit = 'cover',
}: {
  entry: DirEntry;
  thumbCache: Map<string, string>;
  size: number;
  /** Corner radius for the rendered image (px). */
  rounded?: number;
  /** How the thumbnail image should fill its box. */
  objectFit?: 'cover' | 'contain';
}) {
  const officeThumbnailEnabled = useSelector(
    (s: RootState) => s.settings?.officeThumbnailEnabled ?? false
  );
  const sofficePath = useSelector(
    (s: RootState) => s.settings?.sofficePath ?? null
  );

  // Office thumbnails require an external binary and are opt-in; when disabled
  // Office files render as a plain file icon instead of attempting conversion.
  const canThumb =
    !entry.isDirectory &&
    isThumbnailable(entry.name) &&
    (!isOfficeFile(entry.name) || officeThumbnailEnabled);

  const cacheKey = `${entry.path}|${entry.modified}`;
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => thumbCache.get(cacheKey) ?? null
  );
  // Whether the lazy load has finished (regardless of result). Lets a file that
  // genuinely has no thumbnail (e.g. an ebook with no embedded cover, or a
  // failed Office conversion) fall back to a type glyph instead of an endless
  // loading skeleton.
  const [loaded, setLoaded] = useState<boolean>(() => thumbCache.has(cacheKey));

  // P0-1: gate the actual load on visibility. `rootRef` wraps the rendered
  // glyph / image / skeleton — anything is fine, IntersectionObserver just
  // needs the bounding box. We keep the ref attached to a stable wrapper
  // so the observer survives content swaps (skeleton → img).
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Non-thumbnailable files render the glyph immediately — no IPC, no
    // observer needed. Directories DO load (their thumbnail is lazily
    // generated from the first thumbnailable file inside, see `doLoad`), so
    // they must not be short-circuited here.
    if (!entry.isDirectory && !canThumb) return undefined;

    const el = rootRef.current;
    if (!el) return undefined;

    // Synchronous cache fast path: if the parent cache already has the data
    // URL, mirror it into state and skip the observer entirely. This is the
    // common case when re-mounting during scroll.
    const cached = thumbCache.get(cacheKey);
    if (cached) {
      if (cached !== dataUrl) setDataUrl(cached);
      setLoaded(true);
      return undefined;
    }

    let observed = true;

    const doLoad = async (): Promise<void> => {
      if (!observed) return;
      let url: string | null = null;
      if (entry.isDirectory) {
        url = await ipcApi.loadFolderThumbnail(entry.path);
      } else {
        url = await ipcApi.loadThumbnail(entry.path);
        if (!url) {
          // Not generated yet — generate (mtime-shortcircuited in main), re-read.
          const options = isOfficeFile(entry.name) ? { sofficePath } : undefined;
          await ipcApi.generateThumbnail(entry.path, options);
          url = await ipcApi.loadThumbnail(entry.path);
        }
      }
      if (!observed) return; // scrolled away / unmounted mid-load
      if (url) thumbCache.set(cacheKey, url);
      setDataUrl(url ?? null);
      setLoaded(true);
    };

    // IntersectionObserver — only run `doLoad` when the cell scrolls into view
    // (with a 200px lookahead so the visible viewport fills without a flash).
    // `observed` is a state-machine flag: true while the cell is (or just
    // re-entered) the viewport, false after it leaves. doLoad's two guards
    // ignore late results from in-flight loads whose cell has since been
    // recycled to a different entry. Important: `observed` must be reset
    // back to true on every "in view" event — otherwise a cell that briefly
    // scrolls out of the viewport (e.g. user swipes past it) ends up with
    // observed=false for the rest of its lifetime, and every subsequent
    // re-entry hits the first `if (!observed) return;` guard and never
    // issues IPC. The visible symptom is a row of gray Skeleton tiles that
    // never fill in as the user scrolls back over them.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            observed = true;
            enqueueThumbLoad(cacheKey, doLoad);
          } else {
            cancelThumbLoad(cacheKey);
            observed = false;
          }
        }
      },
      { rootMargin: '200px' }
    );
    io.observe(el);

    return () => {
      observed = false;
      cancelThumbLoad(cacheKey);
      io.disconnect();
    };
    // Re-run when the file identity or thumbnailability changes. The latter
    // matters because Office thumbnails are opt-in: enabling the setting must
    // trigger a load for files that previously rendered as plain icons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, canThumb]);

  const renderFolder = (dataUrlValue: string | null) => {
    if (dataUrlValue) {
      return (
        <Box
          sx={{
            position: 'relative',
            width: size,
            height: size,
            // Raw px: `borderRadius: rounded` in sx would be multiplied by
            // theme.shape.borderRadius (8), turning a 40px folder thumb into a
            // ~circle. The file `<img>` below uses an inline px style, so match
            // it here to keep folders and files the same square-with-radius.
            borderRadius: `${rounded}px`,
            overflow: 'hidden',
          }}
        >
          <img
            src={dataUrlValue}
            alt=""
            loading="lazy"
            style={{
              width: size,
              height: size,
              objectFit,
              display: 'block',
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              bottom: 2,
              right: 2,
              width: Math.max(14, size * 0.28),
              height: Math.max(14, size * 0.28),
              borderRadius: '50%',
              bgcolor: 'background.paper',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 1,
              opacity: 0.92,
            }}
          >
            <FolderIcon
              sx={{
                fontSize: Math.max(10, size * 0.18),
                color: 'primary.main',
              }}
            />
          </Box>
        </Box>
      );
    }
    return <FolderIcon sx={{ fontSize: size }} />;
  };

  const renderFile = (dataUrlValue: string | null) => {
    if (!canThumb) {
      return <FileTypeIcon name={entry.name} size={size} />;
    }
    if (dataUrlValue) {
      return (
        <img
          src={dataUrlValue}
          alt=""
          loading="lazy"
          style={{
            width: size,
            height: size,
            objectFit,
            borderRadius: rounded,
            display: 'block',
          }}
        />
      );
    }
    // Load finished with no thumbnail (no embedded cover / failed conversion):
    // show a type glyph rather than an endless skeleton.
    if (loaded) {
      return <FileTypeIcon name={entry.name} size={size} />;
    }
    return <Skeleton variant="rectangular" width={size} height={size} />;
  };

  return (
    <div
      ref={rootRef}
      style={{ display: 'inline-flex', width: size, height: size }}
    >
      {entry.isDirectory ? renderFolder(dataUrl) : renderFile(dataUrl)}
    </div>
  );
}