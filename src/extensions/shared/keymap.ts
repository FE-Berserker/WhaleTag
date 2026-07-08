/**
 * Pure keymap helpers shared by image-viewer + heic-viewer.
 *
 * Extracted from `image-viewer/keymap.ts` so other viewers (HEIC, future
 * image-like extensions) can use the same action vocabulary without
 * importing across extensions. The function is DOM-free except for the
 * `KeyboardEvent` parameter — fully testable under `node:test`.
 *
 * Note: not every action in `ViewerAction` is consumed by every extension.
 * Consumers filter with `switch (action) { ... }` and silently drop
 * actions they don't support (e.g. heic-viewer ignores `rotate` / `flipH`
 * since those are not part of its §四 experience plan).
 */

export type ViewerAction =
  | 'prev'
  | 'next'
  | 'first'
  | 'last'
  | 'zoomIn'
  | 'zoomOut'
  | 'reset'
  | 'actualSize'
  | 'rotate'
  | 'flipH'
  | 'flipV'
  | 'fullscreen';

export interface KeymapContext {
  /** When false, prev/next/first/last are no-ops. */
  hasSiblings: boolean;
  /** When false, zoom/rotate/flip/fullscreen are no-ops (no image yet). */
  hasImage: boolean;
}

/**
 * Maps a KeyboardEvent to a viewer action, or null if the event is not
 * handled (let the browser keep its default — e.g. typing in inputs).
 *
 * Modifier policy: Ctrl/Cmd + wheel is the browser's zoom hint, but inside
 * this iframe we own the wheel handler separately. Keyboard shortcuts
 * intentionally ignore Ctrl/Alt/Meta so they don't fight with browser
 * shortcuts like Ctrl+R (reload) — only the bare key is consulted.
 */
export function keymapAction(
  event: KeyboardEvent,
  ctx: KeymapContext
): ViewerAction | null {
  // Bail on modifier keys so we don't hijack Ctrl+0 / Ctrl+R / etc.
  if (event.ctrlKey || event.altKey || event.metaKey) return null;

  // Don't fire while the user is typing into a (future) input. There are no
  // inputs in the toolbar today, but the guard is cheap and future-proof.
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return null;
  }

  switch (event.key) {
    // Navigation
    case 'ArrowLeft':
    case 'PageUp':
      return ctx.hasSiblings ? 'prev' : null;
    case 'ArrowRight':
    case 'PageDown':
    case ' ': // Space — natural "next" in slideshow UX
      return ctx.hasSiblings ? 'next' : null;
    case 'Home':
      return ctx.hasSiblings ? 'first' : null;
    case 'End':
      return ctx.hasSiblings ? 'last' : null;

    // Zoom
    case '+':
    case '=':
      return ctx.hasImage ? 'zoomIn' : null;
    case '-':
    case '_':
      return ctx.hasImage ? 'zoomOut' : null;
    case '0':
      return ctx.hasImage ? 'reset' : null;
    case '1':
      return ctx.hasImage ? 'actualSize' : null;

    // Rotate / flip
    case 'r':
    case 'R':
      return ctx.hasImage ? 'rotate' : null;
    case 'h':
    case 'H':
      return ctx.hasImage ? 'flipH' : null;
    case 'v':
    case 'V':
      return ctx.hasImage ? 'flipV' : null;

    // Fullscreen
    case 'f':
    case 'F':
      return ctx.hasImage ? 'fullscreen' : null;

    default:
      return null;
  }
}