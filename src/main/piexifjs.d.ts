/**
 * Ambient declaration for `piexifjs` (ships no bundled types and we don't pull
 * in @types). Only the surface used by src/main/exif.test.ts is modelled:
 * GPS IFD tag ids, `dump` to produce an EXIF APP1 payload, and `insert` to
 * splice it into a base64 JPEG data URL.
 */
declare module 'piexifjs' {
  export interface Piexif {
    GPSIFD: {
      GPSLatitudeRef: number;
      GPSLatitude: number;
      GPSLongitudeRef: number;
      GPSLongitude: number;
    };
    dump(exifObj: unknown): string;
    insert(exifBytes: string, jpegDataUrl: string): string;
  }

  const piexif: Piexif;
  export default piexif;
}
