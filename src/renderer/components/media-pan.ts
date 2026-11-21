/** Window-level mouse tracking for one lightbox pan gesture. */

export interface PanEventTarget {
  addEventListener(
    type: 'mousemove' | 'mouseup',
    listener: (event: MouseEvent) => void
  ): void;
  removeEventListener(
    type: 'mousemove' | 'mouseup',
    listener: (event: MouseEvent) => void
  ): void;
}

/** Attach temporary pan listeners and return an idempotent disposer. Mouseup
 * disposes before notifying the caller, so a later close/unmount cleanup is a
 * no-op and cannot remove a newer gesture's listeners. */
export function bindWindowPan(
  target: PanEventTarget,
  onMove: (event: MouseEvent) => void,
  onUp: () => void
): () => void {
  let listening = true;

  function handleMove(event: MouseEvent) {
    if (listening) onMove(event);
  }

  function cleanup() {
    if (!listening) return;
    listening = false;
    target.removeEventListener('mousemove', handleMove);
    target.removeEventListener('mouseup', handleUp);
  }

  function handleUp() {
    cleanup();
    onUp();
  }

  target.addEventListener('mousemove', handleMove);
  target.addEventListener('mouseup', handleUp);
  return cleanup;
}
