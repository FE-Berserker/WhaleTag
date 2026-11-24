/**
 * EXIF / GPS extraction helpers for the Mapique perspective.
 *
 * Runs in the main process so image bytes are never shipped across the IPC
 * boundary; only the extracted `{lat, lng}` (or null) travels to the renderer.
 */

import { getExifr } from './lazy-native';

/**
 * Extract GPS coordinates from an image or video file using exifr.
 * Returns null when the file has no GPS data or cannot be parsed.
 *
 * No per-file logging: batch scans would drown the main-process log, and any
 * `console.*` write is an EPIPE crash vector once the parent process owning
 * the stdio pipe has died (docs/09 §25). Real parse failures still log via
 * `console.error` below; the renderer surfaces routine "no GPS" through the
 * standard notice channel.
 */
export async function extractGps(
  filePath: string
): Promise<{ lat: number; lng: number } | null> {
  try {
    const gps = await getExifr().gps(filePath);
    if (
      !gps ||
      typeof gps.latitude !== 'number' ||
      typeof gps.longitude !== 'number' ||
      Number.isNaN(gps.latitude) ||
      Number.isNaN(gps.longitude)
    ) {
      return null;
    }
    return { lat: gps.latitude, lng: gps.longitude };
  } catch (err) {
    console.error(`[exif] failed to extract GPS from ${filePath}:`, err);
    return null;
  }
}
