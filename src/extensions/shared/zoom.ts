/**
 * Shared zoom / pan / fit-to-window helpers, used by image-viewer and
 * heic-viewer. Pure-math helpers live at the top of the file (testable in
 * isolation under `node:test`); the `createViewportController` factory
 * owns the wiring (wheel / drag / dblclick / ResizeObserver) and the
 * mutable zoom / pan / fitZoom state.
 *
 * Rotation and flip are NOT owned by the controller — they are caller
 * state, because heic-viewer doesn't need them and image-viewer mutates
 * them via toolbar buttons. Callers fetch rotation via `getRotation()`
 * (used by `computeFitZoom` / `clampPan`) and apply the final transform
 * string via `buildTransform(state.pan, state.zoom, rot, flipH, flipV)`.
 *
 * Mirror of the pattern used by html-viewer/html-stats.ts (pure helpers
 * + DOM wiring kept separate).
 */

// ── Constants ───────────────────────────────────────────────────────────

/** Minimum zoom expressed as a multiple of fitZoom (0.25 = can shrink to 1/4 of fit). */
export const MIN_ZOOM_FACTOR_OF_FIT = 0.25;

/** Hard maximum zoom factor (16× natural size). */
export const MAX_ZOOM = 16;

/** Wheel zoom step per notch (10% per `deltaY` unit, exponential). */
export const WHEEL_FACTOR = 1.1;

/** Button / keyboard zoom step (25% per press, multiplicative). */
export const STEP_FACTOR = 1.25;

/** Default margin (px) when clamping pan so the image stays reachable. */
export const DEFAULT_PAN_MARGIN = 24;

export type Rotation = 0 | 90 | 180 | 270;

// ── Pure math helpers ───────────────────────────────────────────────────

/**
 * Compute the zoom factor that makes a rotated image's bounding box fit
 * inside the viewport. The result is `<= 1` (never upscale beyond natural)
 * because "fit-to-window" means "make it fit", not "zoom in".
 *
 * Accounts for rotation: a portrait image rotated 90° has its bounding
 * box become landscape. The caller passes the image's *post-orientation*
 * natural size (e.g. libheif's `display()` already applies EXIF).
 */
export function computeFitZoom(
  natural: { w: number; h: number },
  viewport: { w: number; h: number },
  rotation: Rotation = 0,
): number {
  if (!Number.isFinite(natural.w) || !Number.isFinite(natural.h)) return 1;
  if (natural.w <= 0 || natural.h <= 0) return 1;
  if (!Number.isFinite(viewport.w) || !Number.isFinite(viewport.h)) return 1;
  if (viewport.w <= 0 || viewport.h <= 0) return 1;

  const rad = (rotation * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  // Effective bounding-box dimensions after rotation.
  const effW = natural.w * cosA + natural.h * sinA;
  const effH = natural.w * sinA + natural.h * cosA;
  return Math.min(viewport.w / effW, viewport.h / effH, 1);
}

/**
 * Clamp a 2D pan offset so the image (at current zoom, rotation) does not
 * drift outside the viewport by more than `margin` px. When the image is
 * smaller than the viewport on a given axis, returns 0 on that axis (no
 * panning needed).
 */
export function clampPan(
  pan: { x: number; y: number },
  natural: { w: number; h: number },
  zoom: number,
  viewport: { w: number; h: number },
  rotation: Rotation = 0,
  margin: number = DEFAULT_PAN_MARGIN,
): { x: number; y: number } {
  const rad = (rotation * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const effW = natural.w * cosA + natural.h * sinA;
  const effH = natural.w * sinA + natural.h * cosA;

  return {
    x: clampPanAxis(pan.x, effW * zoom, viewport.w, margin),
    y: clampPanAxis(pan.y, effH * zoom, viewport.h, margin),
  };
}

function clampPanAxis(
  pan: number,
  zoomedSize: number,
  viewportSize: number,
  margin: number,
): number {
  if (!Number.isFinite(pan)) return 0;
  if (zoomedSize <= viewportSize) return 0;
  const maxPan = (zoomedSize - viewportSize) / 2 + margin;
  if (pan > maxPan) return maxPan;
  if (pan < -maxPan) return -maxPan;
  return pan;
}

/**
 * Compute new `{pan, zoom}` after zooming by `factor` around a focal point
 * `(focus.x, focus.y)` in stage-local CSS pixels. The image point that
 * was under the cursor stays under the cursor after the zoom.
 *
 * The result is clamped by `opts.min` / `opts.max` (both default to
 * `[fitZoom * MIN_ZOOM_FACTOR_OF_FIT, MAX_ZOOM]`).
 *
 * `viewport` is the stage rect (CSS pixels).
 */
export function zoomAtPoint(
  factor: number,
  focus: { x: number; y: number },
  state: { pan: { x: number; y: number }; zoom: number },
  natural: { w: number; h: number },
  viewport: { w: number; h: number },
  rotation: Rotation = 0,
  opts: { min?: number; max?: number; fitZoom?: number } = {},
): { pan: { x: number; y: number }; zoom: number } {
  const oldZoom = state.zoom;
  if (!Number.isFinite(factor) || factor <= 0) {
    return { pan: { ...state.pan }, zoom: oldZoom };
  }
  const fitZoom = opts.fitZoom ?? 1;
  const minZoom = opts.min ?? Math.max(fitZoom * MIN_ZOOM_FACTOR_OF_FIT, 0.01);
  const maxZoom = opts.max ?? MAX_ZOOM;
  const newZoom = Math.max(minZoom, Math.min(maxZoom, oldZoom * factor));
  if (newZoom === oldZoom) {
    return { pan: { ...state.pan }, zoom: newZoom };
  }
  const vw = viewport.w / 2;
  const vh = viewport.h / 2;
  const k = newZoom / oldZoom;
  // Cursor-pinning math: keep the image point under the cursor stationary
  // after zoom. `rotation` doesn't enter the math because rotation is
  // applied around the image center (`transform-origin: center`), so the
  // cursor-to-image-point mapping is unchanged across rotations. The
  // parameter is kept in the signature for API symmetry with the other
  // helpers (which DO use rotation for bounding-box math).
  void natural; void rotation;
  return {
    pan: {
      x: (focus.x - vw - state.pan.x) * (k - 1) + state.pan.x * k,
      y: (focus.y - vh - state.pan.y) * (k - 1) + state.pan.y * k,
    },
    zoom: newZoom,
  };
}

/**
 * Build the CSS `transform` string for an `<img>` / `<canvas>` given the
 * transform state. The order is `translate → scale → rotate → flip`
 * (matches the pre-extraction `image-viewer/index.ts` line 153 EXACTLY
 * — any change here is a behavior change for image-viewer).
 */
export function buildTransform(
  pan: { x: number; y: number },
  zoom: number,
  rotation: Rotation,
  flipH: boolean,
  flipV: boolean,
): string {
  const fx = flipH ? -1 : 1;
  const fy = flipV ? -1 : 1;
  return (
    `translate(${pan.x}px, ${pan.y}px) ` +
    `scale(${zoom}) ` +
    `rotate(${rotation}deg) ` +
    `scale(${fx}, ${fy})`
  );
}

// ── Controller ──────────────────────────────────────────────────────────

export interface ViewportState {
  zoom: number;
  fitZoom: number;
  pan: { x: number; y: number };
  hasImage: boolean;
  dragging: boolean;
}

export interface ViewportControllerOptions {
  /** Element that receives `style.transform` (the `<img>` or `<canvas>). */
  imageEl: HTMLElement;
  /** Stage / container that wheel + drag + dblclick + resize events listen on. */
  stageEl: HTMLElement;
  /**
   * Reader for current natural (post-orientation) image dimensions, or
   * `null` when no image is loaded yet.
   */
  getNaturalSize: () => { w: number; h: number } | null;
  /** Reader for the stage rect's CSS-pixel size. */
  getViewportSize: () => { w: number; h: number };
  /**
   * Optional reader for the caller's current rotation (used only by
   * `recomputeFitZoom` / `clampPan` to account for rotated bounding
   * boxes). Defaults to `() => 0` for callers that don't rotate.
   */
  getRotation?: () => Rotation;
  /** Multiplicative zoom factor per wheel notch (default 1.1). */
  wheelFactor?: number;
  /** Hard min/max zoom overrides; defaults to `[fitZoom * 0.25, 16]`. */
  zoomBounds?: { min?: number; max?: number };
  /** Sub-handler switches (all default `true`). */
  enableWheel?: boolean;
  enableDrag?: boolean;
  enableDblClick?: boolean;
  enableResizeObserver?: boolean;
  /** Required: invoked after every state mutation. */
  onChange: (state: ViewportState) => void;
}

export interface ViewportController {
  getState(): ViewportState;
  /** Reset zoom to fit-to-window, pan to (0,0). */
  resetToFit(): void;
  /** Snap to 100% (natural size), pan to (0,0). */
  setActualSize(): void;
  /** Zoom by `factor` around the viewport center. */
  zoomBy(factor: number): void;
  /** Zoom by `STEP_FACTOR` (1.25×) around the viewport center. */
  zoomIn(): void;
  /** Zoom by `1 / STEP_FACTOR` (≈0.8×) around the viewport center. */
  zoomOut(): void;
  /**
   * Called after a new image has loaded. Recomputes fit, sets
   * `hasImage=true`, and applies fit-to-window as the initial view.
   */
  notifyImageLoaded(): void;
  /**
   * Called when the image becomes unavailable (error / unload). Sets
   * `hasImage=false` so subsequent wheel / drag / dblclick / zoom calls
   * become no-ops until `notifyImageLoaded()` is called again.
   */
  notifyImageCleared(): void;
  /** Recompute `fitZoom` from current natural size + viewport + rotation. */
  recomputeFitZoom(): void;
  /** Clamp the current pan against the current state (rotation-aware). */
  clampCurrentPan(): void;
  /** Detach all listeners (cleanup on file switch / navigate-away). */
  destroy(): void;
}

/**
 * Create a viewport controller bound to the given DOM elements. The
 * returned object owns mutable zoom / pan / fitZoom / hasImage / dragging
 * state in a closure. Callbacks (only `onChange`) are invoked after every
 * state mutation so the caller can re-apply the CSS transform.
 */
export function createViewportController(
  opts: ViewportControllerOptions,
): ViewportController {
  const {
    imageEl,
    stageEl,
    getNaturalSize,
    getViewportSize,
    getRotation = () => 0,
    wheelFactor = WHEEL_FACTOR,
    zoomBounds,
    enableWheel = true,
    enableDrag = true,
    enableDblClick = true,
    enableResizeObserver = true,
    onChange,
  } = opts;

  // Mutable state (closure-scoped).
  const state: ViewportState = {
    zoom: 1,
    fitZoom: 1,
    pan: { x: 0, y: 0 },
    hasImage: false,
    dragging: false,
  };

  function emit() {
    // Snapshot so callers can't mutate our internal state.
    onChange({
      zoom: state.zoom,
      fitZoom: state.fitZoom,
      pan: { x: state.pan.x, y: state.pan.y },
      hasImage: state.hasImage,
      dragging: state.dragging,
    });
  }

  function naturalOrNull(): { w: number; h: number } | null {
    return getNaturalSize();
  }

  function getMinZoom(): number {
    if (zoomBounds?.min !== undefined) return zoomBounds.min;
    return Math.max(state.fitZoom * MIN_ZOOM_FACTOR_OF_FIT, 0.01);
  }

  function getMaxZoom(): number {
    return zoomBounds?.max ?? MAX_ZOOM;
  }

  function clampZoom(z: number): number {
    return Math.max(getMinZoom(), Math.min(getMaxZoom(), z));
  }

  // ── Public API ──────────────────────────────────────────────────────

  function getState(): ViewportState {
    return {
      zoom: state.zoom,
      fitZoom: state.fitZoom,
      pan: { x: state.pan.x, y: state.pan.y },
      hasImage: state.hasImage,
      dragging: state.dragging,
    };
  }

  function recomputeFitZoom(): void {
    const natural = naturalOrNull();
    if (!natural) return;
    const viewport = getViewportSize();
    state.fitZoom = computeFitZoom(natural, viewport, getRotation());
  }

  function clampCurrentPan(): void {
    if (!state.hasImage) return;
    const natural = naturalOrNull();
    if (!natural) return;
    const viewport = getViewportSize();
    state.pan = clampPan(
      state.pan, natural, state.zoom, viewport, getRotation(),
    );
  }

  function resetToFit(): void {
    if (!state.hasImage) return;
    recomputeFitZoom();
    state.zoom = state.fitZoom;
    state.pan = { x: 0, y: 0 };
    emit();
  }

  function setActualSize(): void {
    if (!state.hasImage) return;
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    emit();
  }

  function zoomBy(factor: number): void {
    if (!state.hasImage) return;
    const natural = naturalOrNull();
    if (!natural) return;
    const viewport = getViewportSize();
    const next = zoomAtPoint(
      factor,
      { x: viewport.w / 2, y: viewport.h / 2 },
      { pan: state.pan, zoom: state.zoom },
      natural,
      viewport,
      getRotation(),
      { min: getMinZoom(), max: getMaxZoom(), fitZoom: state.fitZoom },
    );
    state.pan = next.pan;
    state.zoom = next.zoom;
    clampCurrentPan();
    emit();
  }

  function zoomIn(): void {
    zoomBy(STEP_FACTOR);
  }

  function zoomOut(): void {
    zoomBy(1 / STEP_FACTOR);
  }

  function notifyImageLoaded(): void {
    state.hasImage = true;
    recomputeFitZoom();
    state.zoom = state.fitZoom;
    state.pan = { x: 0, y: 0 };
    emit();
  }

  function notifyImageCleared(): void {
    state.hasImage = false;
    state.dragging = false;
    if (dragOrigin) {
      dragOrigin = null;
      stageEl.classList.remove('dragging');
    }
    emit();
  }

  // ── Wheel handler ───────────────────────────────────────────────────

  function onWheel(e: WheelEvent): void {
    if (!state.hasImage) return;
    e.preventDefault();
    const natural = naturalOrNull();
    if (!natural) return;
    const viewport = getViewportSize();
    const rect = stageEl.getBoundingClientRect();
    const focus = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Smooth trackpad pinch gestures stream small deltas; physical wheels
    // produce larger deltas. Map both to an exponential factor — matches
    // the original image-viewer behavior (line 232) for zero behavior
    // change. `wheelFactor` is documented for future tuning but kept
    // out of the math so the pre-extraction feel is preserved exactly.
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = zoomAtPoint(
      factor,
      focus,
      { pan: state.pan, zoom: state.zoom },
      natural,
      viewport,
      getRotation(),
      { min: getMinZoom(), max: getMaxZoom(), fitZoom: state.fitZoom },
    );
    state.pan = next.pan;
    state.zoom = next.zoom;
    clampCurrentPan();
    emit();
  }

  // ── Drag handler ────────────────────────────────────────────────────

  let dragOrigin: { x: number; y: number; panX: number; panY: number } | null = null;

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (!state.hasImage) return;
    // Only drag when zoomed in past fit; otherwise pan(0,0) and dragging
    // would do nothing useful (and would steal text-selection-like
    // gestures from any overlay).
    if (state.zoom <= state.fitZoom + 1e-3) return;
    dragOrigin = {
      x: e.clientX,
      y: e.clientY,
      panX: state.pan.x,
      panY: state.pan.y,
    };
    state.dragging = true;
    stageEl.classList.add('dragging');
    emit();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragOrigin) return;
    state.pan = {
      x: dragOrigin.panX + (e.clientX - dragOrigin.x),
      y: dragOrigin.panY + (e.clientY - dragOrigin.y),
    };
    clampCurrentPan();
    emit();
  }

  function endDrag(): void {
    if (!dragOrigin) return;
    dragOrigin = null;
    state.dragging = false;
    stageEl.classList.remove('dragging');
    emit();
  }

  // ── Double-click handler ────────────────────────────────────────────

  function onDblClick(e: MouseEvent): void {
    e.preventDefault();
    if (!state.hasImage) return;
    const rect = stageEl.getBoundingClientRect();
    const focus = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // If at fit (or close), zoom to 100% at cursor. Otherwise reset to fit.
    if (state.zoom <= state.fitZoom + 1e-3) {
      const natural = naturalOrNull();
      if (!natural) return;
      const viewport = getViewportSize();
      const next = zoomAtPoint(
        1 / state.zoom, // bump zoom to 1
        focus,
        { pan: state.pan, zoom: state.zoom },
        natural,
        viewport,
        getRotation(),
        { min: getMinZoom(), max: getMaxZoom(), fitZoom: state.fitZoom },
      );
      state.pan = next.pan;
      state.zoom = next.zoom;
      clampCurrentPan();
      emit();
    } else {
      resetToFit();
    }
  }

  // ── Resize observer ─────────────────────────────────────────────────

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (!state.hasImage) return;
        const wasFit = Math.abs(state.zoom - state.fitZoom) < 1e-3;
        const oldFit = state.fitZoom;
        recomputeFitZoom();
        if (wasFit) {
          state.zoom = state.fitZoom;
        } else if (oldFit > 0) {
          // Preserve zoom *ratio* relative to fit so the user doesn't
          // feel the image shrink/grow when only the viewport changed.
          state.zoom = (state.zoom / oldFit) * state.fitZoom;
        }
        clampCurrentPan();
        emit();
      })
    : null;

  // ── Lifecycle ───────────────────────────────────────────────────────

  if (enableWheel) {
    stageEl.addEventListener('wheel', onWheel, { passive: false });
  }
  if (enableDrag) {
    stageEl.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
  }
  if (enableDblClick) {
    stageEl.addEventListener('dblclick', onDblClick);
  }
  if (enableResizeObserver && ro) {
    ro.observe(stageEl);
  }

  function destroy(): void {
    if (enableWheel) stageEl.removeEventListener('wheel', onWheel);
    if (enableDrag) {
      stageEl.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);
    }
    if (enableDblClick) stageEl.removeEventListener('dblclick', onDblClick);
    if (ro) ro.disconnect();
    dragOrigin = null;
    state.dragging = false;
    state.hasImage = false;
  }

  return {
    getState,
    resetToFit,
    setActualSize,
    zoomBy,
    zoomIn,
    zoomOut,
    notifyImageLoaded,
    notifyImageCleared,
    recomputeFitZoom,
    clampCurrentPan,
    destroy,
  };
}