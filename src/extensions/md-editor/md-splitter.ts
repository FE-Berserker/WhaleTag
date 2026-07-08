/**
 * md-editor — resizable splitter between the editor and preview panes.
 *
 * The HTML already renders `#splitter` with `cursor: col-resize` (§18.1.1
 * in the docs), but there was no JS to actually drag. This module wires
 * mousedown / mousemove / mouseup on the splitter, persists the resulting
 * ratio to localStorage, and supports a double-click reset to 50:50.
 *
 * The ratio is applied as `flex-basis: ${ratio * 100}%` on the editor
 * pane, with the preview pane keeping its CSS `flex: 1` (grow to fill
 * remaining space). The splitter itself stays at its CSS 4px width. This
 * composition means a minimum ratio (`MIN`, default 0.2) still leaves the
 * editor readable, and the symmetric maximum (`MAX`, default 0.8) caps
 * the preview's shrink — both panes stay usable.
 *
 * No-op in environments without `window.localStorage` (e.g. some privacy
 * modes); the drag still works in-memory, the ratio is just not persisted.
 *
 * See docs/07 §4.1 / docs/09 §18.1.1 for context.
 */

export interface SplitterOptions {
  /** Editor pane element. Its `flex` is mutated to `0 0 ${ratio*100}%`. */
  editorPane: HTMLElement;
  /** Preview pane element. Keeps its CSS `flex: 1` to absorb the rest. */
  previewPane: HTMLElement;
  /** The drag handle (the 4px column between the two panes). */
  splitter: HTMLElement;
  /**
   * The container that both panes live in. Its `getBoundingClientRect()`
   * is the basis for translating mouseX → ratio.
   */
  container: HTMLElement;
  /** localStorage key for the persisted ratio. Default `md-editor-split-ratio`. */
  storageKey?: string;
  /** Lower bound on the editor's share. Default 0.2. */
  minRatio?: number;
  /** Upper bound on the editor's share. Default 0.8. */
  maxRatio?: number;
  /** Called after every apply (drag tick, reset, programmatic set). */
  onChange?: (ratio: number) => void;
}

export interface SplitterHandle {
  /** Programmatic set. Persists to localStorage. */
  setRatio(ratio: number): void;
  /** Reset to 50:50. Persists. */
  reset(): void;
  /** Returns the current ratio. */
  getRatio(): number;
  /** Remove all listeners. Use on iframe unload. */
  destroy(): void;
}

const DEFAULT_KEY = 'md-editor-split-ratio';
const DEFAULT_MIN = 0.2;
const DEFAULT_MAX = 0.8;

function clamp(r: number, min: number, max: number): number {
  if (Number.isNaN(r)) return (min + max) / 2;
  return Math.max(min, Math.min(max, r));
}

function tryGetItem(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function trySetItem(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    /* privacy mode or storage full — ignore */
  }
}

export function setupSplitter(opts: SplitterOptions): SplitterHandle {
  const {
    editorPane,
    previewPane,
    splitter,
    container,
    storageKey = DEFAULT_KEY,
    minRatio = DEFAULT_MIN,
    maxRatio = DEFAULT_MAX,
  } = opts;

  // Sync a11y attributes on the splitter element.
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-valuemin', String(Math.round(minRatio * 100)));
  splitter.setAttribute('aria-valuemax', String(Math.round(maxRatio * 100)));
  splitter.setAttribute('tabindex', '0');

  const initial = (() => {
    const v = tryGetItem(storageKey);
    if (v) {
      const n = parseFloat(v);
      if (!Number.isNaN(n) && n > 0 && n < 1) return clamp(n, minRatio, maxRatio);
    }
    return 0.5;
  })();

  let ratio = initial;
  let dragging = false;

  function apply(next: number, persist: boolean): void {
    const clamped = clamp(next, minRatio, maxRatio);
    ratio = clamped;
    editorPane.style.flex = `0 0 ${(clamped * 100).toFixed(3)}%`;
    // Preview pane keeps CSS `flex: 1` (basis 0, grow into remaining space).
    // Forcing a fresh basis here is unnecessary; the editor's `flex: 0 0 X%`
    // takes precedence for layout. We still touch the style to invalidate
    // any flex cache the browser may have.
    void previewPane;
    splitter.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
    if (persist) trySetItem(storageKey, clamped.toFixed(4));
    opts.onChange?.(clamped);
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // only left button
    dragging = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.setAttribute('data-editor-dragging', 'true');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const next = (e.clientX - rect.left) / rect.width;
    apply(next, false);
  }

  function onMouseUp(): void {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.removeAttribute('data-editor-dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    apply(ratio, true);
  }

  function onDblClick(e: MouseEvent): void {
    // Guard against an in-flight drag (browsers can fire dblclick after
    // mousedown/mouseup of a single click that started a drag).
    if (dragging) return;
    e.preventDefault();
    apply(0.5, true);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Arrow-key nudge for keyboard accessibility. Each press = 2% step;
    // Home/End jump to min/max.
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = ratio - 0.02;
    else if (e.key === 'ArrowRight') next = ratio + 0.02;
    else if (e.key === 'Home') next = minRatio;
    else if (e.key === 'End') next = maxRatio;
    if (next !== null) {
      e.preventDefault();
      apply(next, true);
    }
  }

  splitter.addEventListener('mousedown', onMouseDown);
  splitter.addEventListener('dblclick', onDblClick);
  splitter.addEventListener('keydown', onKeyDown);

  // Apply initial ratio (no persist; the stored value is already in sync).
  apply(initial, false);

  return {
    setRatio(next: number) {
      apply(next, true);
    },
    reset() {
      apply(0.5, true);
    },
    getRatio() {
      return ratio;
    },
    destroy() {
      splitter.removeEventListener('mousedown', onMouseDown);
      splitter.removeEventListener('dblclick', onDblClick);
      splitter.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.removeAttribute('data-editor-dragging');
    },
  };
}
