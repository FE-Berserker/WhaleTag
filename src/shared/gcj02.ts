/**
 * WGS-84 ↔ GCJ-02 coordinate transform.
 *
 * China mandates the GCJ-02 ("Mars") datum for maps published within the
 * country, which applies a non-linear offset to true WGS-84 coordinates.
 * Gaode/AutoNavi (and most domestic providers) serve GCJ-02 tiles, while GPS
 * EXIF and our stored `geo:lat,lng` tags are WGS-84. Placing raw WGS-84 points
 * on a GCJ-02 base map shows them offset by ~100–700 m inside China.
 *
 * These pure functions convert between the two so markers land correctly and
 * map clicks are stored back as WGS-84. The algorithm is the widely-used
 * "eviltransform" approximation; it is accurate to a few metres, which is far
 * better than the offset it corrects. Outside China the datums coincide, so
 * {@link outOfChina} short-circuits to an identity transform.
 *
 * React/Electron-free so it can be unit-tested in isolation.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

// Krasovsky 1940 ellipsoid params used by the GCJ-02 algorithm.
const A = 6378245.0; // semi-major axis
const EE = Number('0.00669342162296594323'); // eccentricity squared
const PI = Math.PI;

/**
 * True when the point lies outside mainland China's rough bounding box. The
 * GCJ-02 offset is only defined within China; elsewhere WGS-84 == GCJ-02.
 */
export function outOfChina(lat: number, lng: number): boolean {
  return !(lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271);
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) *
      2.0) /
    3.0;
  return ret;
}

/** The delta (in degrees) added to a WGS-84 point to obtain GCJ-02. */
function delta(lat: number, lng: number): LatLng {
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: dLat, lng: dLng };
}

/** Convert a true WGS-84 coordinate to GCJ-02 (for display on Gaode tiles). */
export function wgs84ToGcj02(lat: number, lng: number): LatLng {
  if (outOfChina(lat, lng)) return { lat, lng };
  const d = delta(lat, lng);
  return { lat: lat + d.lat, lng: lng + d.lng };
}

/**
 * Convert a GCJ-02 coordinate (e.g. a click on a Gaode map) back to WGS-84.
 * Inverse of {@link wgs84ToGcj02}. The forward transform has no closed-form
 * inverse, so we iterate: guess a WGS-84 point, transform it forward, and
 * correct by the residual. A handful of passes converge to sub-millimetre.
 */
export function gcj02ToWgs84(lat: number, lng: number): LatLng {
  if (outOfChina(lat, lng)) return { lat, lng };
  let wgsLat = lat;
  let wgsLng = lng;
  for (let i = 0; i < 5; i += 1) {
    const g = wgs84ToGcj02(wgsLat, wgsLng);
    wgsLat += lat - g.lat;
    wgsLng += lng - g.lng;
  }
  return { lat: wgsLat, lng: wgsLng };
}
