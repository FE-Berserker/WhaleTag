import { memo, useMemo } from 'react';
import { Marker, Popup } from 'react-leaflet';
import type * as L from 'leaflet';
import type { TFunction } from 'i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import type { TagGroup } from '../../domain/tag-library';
import type { GeoEntry } from '../../domain/mapique';
import type { MapProvider } from '-/reducers/settings';
import MapPopup from './MapPopup';
import { makePinIcon } from './pin-icon';

/**
 * P0-3 (perf audit): a single geo marker, React.memo'd so it only re-renders
 * when its OWN inputs change (active/selected state, color, position,
 * draggable). The parent re-renders on every pan / select / hover / sort /
 * `setMapCenter`, but unchanged markers bail out entirely — no fresh
 * `makePinIcon` DivIcon (DOM rebuild) and no react-leaflet event rebind.
 *
 * Granularity matters: passing the primitive `state` ('normal' | 'selected'
 * | 'active') instead of the whole `selected` Set means a selection change
 * only re-renders the one marker whose state actually changed, not every
 * marker. The icon / position / event-handlers are each memoized inside so
 * that even when a re-render does occur, react-leaflet skips setIcon /
 * setPosition / (un)bind for the fields that didn't change.
 */
export default memo(function GeoMarker({
  geo,
  color,
  state,
  draggable,
  displayLat,
  displayLng,
  onSelect,
  onContextMenu,
  onDragEnd,
  thumbCache,
  tagsByName,
  tagColors,
  groups,
  t,
  provider,
  onOpen,
}: {
  geo: GeoEntry;
  color: string;
  state: 'normal' | 'selected' | 'active';
  draggable: boolean;
  displayLat: number;
  displayLng: number;
  onSelect: (path: string, mods: { shift: boolean; ctrl: boolean }) => void;
  onContextMenu: (geo: GeoEntry, x: number, y: number) => void;
  onDragEnd: (geo: GeoEntry, lat: number, lng: number) => void;
  thumbCache: Map<string, string>;
  tagsByName: Map<string, string[]>;
  tagColors?: Record<string, string>;
  groups?: TagGroup[];
  t: TFunction;
  provider?: MapProvider;
  onOpen?: (entry: DirEntry) => void;
}) {
  const icon = useMemo(
    () => makePinIcon(color, state, geo.entry.path),
    [color, state, geo.entry.path]
  );
  const position = useMemo<[number, number]>(
    () => [displayLat, displayLng],
    [displayLat, displayLng]
  );
  const eventHandlers = useMemo(
    () => ({
      click: (e: L.LeafletMouseEvent) => {
        const native = e.originalEvent as MouseEvent | undefined;
        onSelect(geo.entry.path, {
          shift: native?.shiftKey ?? false,
          ctrl: (native?.ctrlKey ?? false) || (native?.metaKey ?? false),
        });
      },
      contextmenu: (e: L.LeafletMouseEvent) => {
        const native = e.originalEvent as MouseEvent | undefined;
        if (!native) return;
        native.preventDefault();
        native.stopPropagation();
        onContextMenu(geo, native.clientX, native.clientY);
      },
      dragend: (e: L.DragEndEvent) => {
        const m = e.target as L.Marker;
        const ll = m.getLatLng();
        onDragEnd(geo, ll.lat, ll.lng);
      },
    }),
    [geo, onSelect, onContextMenu, onDragEnd]
  );
  return (
    <Marker
      position={position}
      icon={icon}
      draggable={draggable}
      eventHandlers={eventHandlers}
    >
      <Popup maxWidth={220} minWidth={180}>
        <MapPopup
          geo={geo}
          thumbCache={thumbCache}
          tags={tagsByName.get(geo.entry.path) ?? []}
          tagColors={tagColors}
          groups={groups}
          t={t}
          provider={provider}
          onOpen={onOpen}
        />
      </Popup>
    </Marker>
  );
});
