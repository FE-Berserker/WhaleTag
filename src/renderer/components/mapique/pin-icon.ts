import L from 'leaflet';

/** Escapes a value for an HTML attribute. Leaflet's DivIcon renders `html`
 *  through `innerHTML`, so an unescaped path containing a quote would break
 *  out of the attribute and become live markup. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes a value for a double-quoted CSS attribute selector string. */
export function cssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build a CSS-only pin marker. `color` is shared with the tray indicator;
 *  selected/active states keep the fill color and add a colored border.
 *  P3-2: the inner shape is wrapped in `.whale-pin-wrap` carrying
 *  `data-entry-path` so a parent effect can toggle `.whale-pin-bounce` to
 *  animate the pin when its tray row is hovered. */
export function makePinIcon(
  color: string,
  state: 'normal' | 'selected' | 'active',
  entryPath?: string
): L.DivIcon {
  const isActive = state === 'active';
  const isSelected = state === 'selected';
  const size = isActive ? 30 : isSelected ? 26 : 24;
  const borderColor = isActive ? '#f44336' : isSelected ? '#ff9800' : '#fff';
  const borderWidth = isActive ? 3 : isSelected ? 3 : 2;
  const shadow = isActive
    ? '0 3px 6px rgba(0,0,0,0.5)'
    : '0 2px 4px rgba(0,0,0,0.4)';
  return L.divIcon({
    className: `whale-map-pin-${state}`,
    html: `<div class="whale-pin-wrap" data-entry-path="${escapeAttr(entryPath ?? '')}" style="
      display: flex;
      align-items: center;
      justify-content: center;
      width: ${size}px;
      height: ${size}px;
    "><div style="
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border: ${borderWidth}px solid ${borderColor};
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: ${shadow};
    "></div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -(size * 0.85)],
  });
}
