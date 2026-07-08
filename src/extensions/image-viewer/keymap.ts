/**
 * Image-viewer-local helpers. The shared `keymapAction` / `ViewerAction` /
 * `KeymapContext` live in `../shared/keymap` so other viewers (e.g.
 * heic-viewer) can reuse them without cross-extension imports. This file
 * keeps the image-viewer-only `siblingTarget` (sibling list navigation is
 * an image-viewer concept, not a generic viewer concept).
 *
 * The wiring lives in `index.ts`: it listens to `keydown` on the iframe
 * document, calls `keymapAction(event, ctx)`, and dispatches the returned
 * action to the right state mutator. The context shape is intentionally
 * narrow — `index.ts` decides the rest.
 */

export {
  keymapAction,
  type KeymapContext,
  type ViewerAction,
} from '../shared/keymap';

/**
 * Returns the path to navigate to (prev / next / first / last) or null when
 * the requested direction isn't available. Wraps around — the caller is
 * the source of truth for "wrap vs. clamp", and the spec (lightbox UX) is
 * wrap-by-default. Single-element lists return the same path so the user
 * gets visual feedback that the key worked without leaving the file.
 */
export type SiblingDirection = 'prev' | 'next' | 'first' | 'last';

export function siblingTarget(
  paths: readonly string[],
  current: string,
  direction: SiblingDirection
): string | null {
  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0];

  const idx = paths.indexOf(current);
  // If `current` isn't in the list, fall back to the first / last entry.
  if (idx < 0) {
    return direction === 'last' ? paths[paths.length - 1] : paths[0];
  }

  switch (direction) {
    case 'first':
      return paths[0];
    case 'last':
      return paths[paths.length - 1];
    case 'prev':
      return paths[(idx - 1 + paths.length) % paths.length];
    case 'next':
      return paths[(idx + 1) % paths.length];
  }
}
