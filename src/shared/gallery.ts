/**
 * Pure helpers for the Gallery perspective / media lightbox. Kept free of React
 * and Electron so the playlist-building and circular-navigation logic can be
 * unit-tested in isolation (see gallery.test.ts).
 */

import type { DirEntry } from './ipc-types';
import { isImageFile, isVideoFile } from './whale-meta';

/** True if `entry` is a file Whale can show in the gallery lightbox. */
export function isMediaEntry(entry: DirEntry): boolean {
  return entry.isFile && (isImageFile(entry.name) || isVideoFile(entry.name));
}

/**
 * The ordered playlist for the gallery/lightbox: the image and video files of
 * `entries`, in their existing (already-sorted) order. Directories and non-media
 * files are dropped.
 */
export function mediaPlaylist(entries: DirEntry[]): DirEntry[] {
  return entries.filter(isMediaEntry);
}

/**
 * Wraps `index` into `[0, length)` so prev/next loop around the playlist.
 * Returns 0 for an empty playlist (`length <= 0`).
 */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
