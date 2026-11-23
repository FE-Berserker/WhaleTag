import type { DirEntry } from '../../../shared/ipc-types';
import MediaLightbox from '-/components/MediaLightbox';
import { isMediaEntry } from '../../domain/gallery';

export interface FileListLightboxProps {
  /** Entry the user double-clicked / opened through `whale:open-lightbox`. */
  entry: DirEntry | null;
  /** Playlist derived from the current `visible` entries. */
  playlist: DirEntry[];
  /** Single-entry fallback used when `entry` is not in `playlist`. */
  fallbackPlaylist: DirEntry[];
  thumbCache: Map<string, string>;
  onClose: () => void;
}

/**
 * Full-screen media lightbox for double-clicking media in list/grid
 * (P2 FileList split).
 *
 * The playlist is the current post-filter `visible` list; when the opened
 * entry sits outside it — e.g. opening from FolderViz where the file lives in
 * a subdirectory list/grid isn't showing — fall back to a single-entry
 * playlist so the preview still opens. Non-media entries outside the playlist
 * render nothing.
 */
export default function FileListLightbox({
  entry,
  playlist,
  fallbackPlaylist,
  thumbCache,
  onClose,
}: FileListLightboxProps) {
  if (entry === null) return null;
  const idx = playlist.findIndex((e) => e.path === entry.path);
  if (idx < 0) {
    if (!isMediaEntry(entry)) return null;
    return (
      <MediaLightbox
        open
        entries={fallbackPlaylist}
        initialIndex={0}
        onClose={onClose}
        thumbCache={thumbCache}
      />
    );
  }
  return (
    <MediaLightbox
      open
      entries={playlist}
      initialIndex={idx}
      onClose={onClose}
      thumbCache={thumbCache}
    />
  );
}
