import { useEffect, useRef } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

import type { GeoEntry } from '../../domain/mapique';

/** H.26 P0-1: captures map blank right-clicks and forwards display coords. */
export function MapContextMenuHandler({
  onContextMenu,
}: {
  onContextMenu: (lat: number, lng: number, x: number, y: number) => void;
}) {
  useMapEvents({
    contextmenu(e) {
      const native = e.originalEvent as MouseEvent | undefined;
      if (!native) return;
      native.preventDefault();
      native.stopPropagation();
      onContextMenu(e.latlng.lat, e.latlng.lng, native.clientX, native.clientY);
    },
  });
  return null;
}

/**
 * P3-5: pushes the live viewport center to the parent on every pan/zoom.
 * The `distance` tray sort uses this as its reference point (falling back
 * to the initial fitBounds centroid until the first user interaction).
 * `moveend` fires after both user drags and programmatic `setView`/`fitBounds`
 * calls, so "Fit to bounds" also re-orders the tray.
 */
export function MapMoveTracker({
  onMoveEnd,
}: {
  onMoveEnd: (center: { lat: number; lng: number }) => void;
}) {
  const map = useMap();
  useMapEvents({
    moveend() {
      const c = map.getCenter();
      onMoveEnd({ lat: c.lat, lng: c.lng });
    },
  });
  return null;
}

/** Captures map clicks and forwards their coordinates. */
export function MapClickHandler({
  onClick,
  lastDragEndAtRef,
}: {
  onClick: (lat: number, lng: number) => void;
  lastDragEndAtRef: React.MutableRefObject<number>;
}) {
  useMapEvents({
    click(e) {
      // Suppress the click Leaflet fires immediately after a marker dragend —
      // a drag already wrote the new coordinate via its own handler, and the
      // map-plane click would otherwise overwrite it with a different point
      // (plan §H.21 / Bug #2).
      if (Date.now() - lastDragEndAtRef.current < 100) return;
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * Forces Leaflet to recompute its size. A map created inside a flex/conditional
 * layout is frequently initialized before its container has settled to its
 * final dimensions; without this it renders blank (no tiles requested) until
 * the next manual resize. Runs after mount and on every container resize.
 */
export function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const invalidate = () => map.invalidateSize();
    const t1 = setTimeout(invalidate, 0);
    const t2 = setTimeout(invalidate, 250);
    const container = map.getContainer();
    const ro = new ResizeObserver(invalidate);
    ro.observe(container);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
    };
  }, [map]);
  return null;
}

/** Recomputes map size whenever `trigger` changes (e.g. the panel toggles). */
export function InvalidateOnChange({ trigger }: { trigger: unknown }) {
  const map = useMap();
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 0);
    const t2 = setTimeout(() => map.invalidateSize(), 320);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [trigger, map]);
  return null;
}

/**
 * Re-centers/fits the map whenever the set of known GPS points changes.
 * Points are stored in WGS-84; `toDisplay` shifts them to the active tile
 * datum so the fitted bounds match the rendered markers.
 */
export function FitBounds({
  geo,
  toDisplay,
}: {
  geo: GeoEntry[];
  toDisplay: (lat: number, lng: number) => [number, number];
}) {
  const map = useMap();
  // Track the point SET, not its size: the old `geo.length > prev` gate never
  // fired on first mount (prev started at geo.length), so a map opened with
  // markers already present showed the whole world until one more tagged file
  // appeared; replacing points (filters, re-tags) never re-fit either.
  const prevKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (geo.length === 0) {
      prevKeysRef.current = new Set();
      return;
    }
    const keys = new Set(geo.map((g) => `${g.lat},${g.lng}`));
    const hadPoints = prevKeysRef.current.size > 0;
    let hasNewPoint = false;
    for (const key of keys) {
      if (!prevKeysRef.current.has(key)) {
        hasNewPoint = true;
        break;
      }
    }
    prevKeysRef.current = keys;
    // Keep the user's view when nothing new showed up (panning/zooming is
    // theirs); refit only when the set gained a point or was empty before.
    if (!hasNewPoint && hadPoints) return;
    const group = L.featureGroup(geo.map((g) => L.marker(toDisplay(g.lat, g.lng))));
    map.fitBounds(group.getBounds().pad(0.1));
  }, [geo, map, toDisplay]);

  return null;
}
