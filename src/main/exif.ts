/**
 * EXIF / GPS extraction helpers for the Mapique perspective.
 *
 * Runs in the main process so image bytes are never shipped across the IPC
 * boundary; only the extracted `{lat, lng}` (or null) travels to the renderer.
 */

import { getExifr } from './lazy-native';

/**
 * P3-7: a small, render-friendly subset of EXIF metadata shown in the
 * map-marker popup. Every field is optional — only what the file actually
 * carries comes through; the renderer hides empty rows so the popup stays
 * compact. Returned alongside the file path so the cache can key on it.
 */
export interface ExifSummary {
  /** ISO-8601 timestamp from `DateTimeOriginal` (or `CreateDate` fallback). */
  dateTaken: string | null;
  /** Camera make + model, e.g. "Apple iPhone 15 Pro". Null when unknown. */
  camera: string | null;
  /** Lens model, e.g. "iPhone 15 Pro back camera 6.86mm f/1.78". Null when unknown. */
  lens: string | null;
  /** Focal length in mm. Null when unknown. */
  focalLength: number | null;
  /** ISO speed. Null when unknown. */
  iso: number | null;
  /** Shutter speed as a fraction, e.g. "1/250". Null when unknown. */
  shutterSpeed: string | null;
}

/** P3-7: build the popup summary from a parsed exifr payload. Pure helper so
 *  it's testable without constructing a real image — the IPC handler and
 *  the unit tests both go through here. */
export function buildExifSummary(raw: unknown): ExifSummary {
  const d = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;

  // DateTimeOriginal is the photographer's intent; CreateDate is the
  // filesystem write time. Prefer the former.
  const taken = (d.DateTimeOriginal ?? d.CreateDate) as Date | string | undefined;
  let dateTaken: string | null = null;
  if (taken instanceof Date && !Number.isNaN(taken.getTime())) {
    dateTaken = taken.toISOString();
  } else if (typeof taken === 'string' && taken.trim() !== '') {
    // exifr sometimes hands us the EXIF-style "YYYY:MM:DD HH:MM:SS" string
    // for older files; normalise to ISO so the renderer doesn't have to
    // branch on format.
    const normalised = taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const d2 = new Date(normalised);
    dateTaken = Number.isNaN(d2.getTime()) ? taken : d2.toISOString();
  }

  const make = str(d.Make);
  const model = str(d.Model);
  // Some cameras (Fujifilm in particular) embed the make in the model
  // string ("FUJIFILM X-T5" + Make: "FUJIFILM" → would duplicate). If
  // the model already starts with the make, just return the model.
  let camera: string | null = null;
  if (make && model) {
    if (model.startsWith(make)) camera = model;
    else camera = `${make} ${model}`;
  } else {
    camera = make ?? model;
  }

  const lens = str(d.LensModel) ?? str(d.Lens);

  // exifr returns FocalLength as a number when available; older cameras
  // sometimes store it as a rational tuple — fall back to the first element.
  const focalLengthRaw = d.FocalLength;
  let focalLength: number | null = null;
  if (typeof focalLengthRaw === 'number') {
    focalLength = num(focalLengthRaw);
  } else if (
    Array.isArray(focalLengthRaw) &&
    typeof focalLengthRaw[0] === 'number'
  ) {
    focalLength = num(focalLengthRaw[0]);
  }

  // ExposureTime is a fraction (e.g. 0.004 = 1/250s). Format as "1/N" when
  // it represents a fraction of a second slower than 1s, otherwise as a
  // decimal (e.g. "2.5" for 2.5s).
  let shutterSpeed: string | null = null;
  const exp = num(d.ExposureTime);
  if (exp !== null) {
    if (exp >= 1) {
      shutterSpeed = `${exp}s`;
    } else if (exp > 0) {
      const denom = Math.round(1 / exp);
      shutterSpeed = `1/${denom}`;
    } else {
      shutterSpeed = '0';
    }
  }

  return {
    dateTaken,
    camera,
    lens,
    focalLength,
    iso: num(d.ISO ?? d.ISOSpeedRatings),
    shutterSpeed,
  };
}

/**
 * Extract GPS coordinates from an image or video file using exifr.
 * Returns null when the file has no GPS data or cannot be parsed.
 *
 * Logging stays at `console.debug` for the routine "no GPS" path — the renderer
 * already surfaces failures through the standard notice channel, and a folder
 * with hundreds of EXIF-less photos would otherwise drown the main-process log
 * (plan §H.21 P3 cleanup, exif.ts noise reduction).
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
      console.debug(`[exif] no GPS: ${filePath}`);
      return null;
    }
    console.debug(`[exif] GPS found: ${filePath} → ${gps.latitude}, ${gps.longitude}`);
    return { lat: gps.latitude, lng: gps.longitude };
  } catch (err) {
    console.error(`[exif] failed to extract GPS from ${filePath}:`, err);
    return null;
  }
}

/**
 * P3-7: read the popup-relevant EXIF subset for one file. Returns an empty
 * summary (all fields null) when the file has no EXIF, the format isn't
 * supported, or parsing fails — never throws. The renderer treats an all-null
 * summary the same as "EXIF unavailable" and skips the section.
 */
export async function getExifSummary(filePath: string): Promise<ExifSummary> {
  try {
    // `pick` keeps the parser focused on the fields we care about — saves
    // a few ms per call vs. parsing the whole EXIF tree.
    const raw = await getExifr().parse(filePath, {
      pick: [
        'Make',
        'Model',
        'LensModel',
        'Lens',
        'FocalLength',
        'ISO',
        'ISOSpeedRatings',
        'ExposureTime',
        'FNumber',
        'DateTimeOriginal',
        'CreateDate',
      ],
    });
    return buildExifSummary(raw);
  } catch (err) {
    console.debug(`[exif] summary unavailable for ${filePath}:`, err);
    return {
      dateTaken: null,
      camera: null,
      lens: null,
      focalLength: null,
      iso: null,
      shutterSpeed: null,
    };
  }
}
