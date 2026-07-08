/**
 * Image viewer — lightbox-style surface for jpg/jpeg/png/gif/webp/bmp/avif/
 * tiff/tif/ico/svg. Built per `docs/07-extensions.md` §四.
 *
 * Pure helpers (keymap, sibling nav, pan clamp) live in `./keymap.ts`; the
 * shared `keymapAction` was extracted to `../shared/keymap.ts` so other
 * viewers can reuse it. Zoom / pan / fit-to-window / wheel / drag /
 * dblclick / ResizeObserver were extracted to `../shared/zoom.ts`'s
 * `createViewportController` factory so heic-viewer can share the same
 * transform pipeline. This file owns the per-file rotation / flip /
 * fullscreen / sibling navigation state.
 *
 * Coordinate model: a single CSS `transform: translate() scale() rotate()
 * scale()` is applied to #image. The translate is in viewport pixels; the
 * image is centered at the stage's center by the flex layout, so pan(0,0)
 * means "perfectly centered". Zoom and rotation both happen around the
 * image's own center (transform-origin: center).
 */
import './viewer.css';
import type { HostMessage } from '../../shared/extension-types';
import {
  buildTransform,
  createViewportController,
  type ViewportController,
  type Rotation,
} from '../shared/zoom';
import { keymapAction, siblingTarget, type SiblingDirection } from './keymap';

// ── DOM refs ────────────────────────────────────────────────────────────
const stageEl = document.getElementById('stage') as HTMLDivElement;
const imageEl = document.getElementById('image') as HTMLImageElement;
const loadingEl = document.getElementById('loading') as HTMLDivElement;
const errorEl = document.getElementById('error') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const counterEl = document.getElementById('counter') as HTMLSpanElement;
const zoomReadoutEl = document.getElementById('zoom-readout') as HTMLSpanElement;

const btnPrev = document.getElementById('prev') as HTMLButtonElement;
const btnNext = document.getElementById('next') as HTMLButtonElement;
const btnZoomOut = document.getElementById('zoom-out') as HTMLButtonElement;
const btnZoomIn = document.getElementById('zoom-in') as HTMLButtonElement;
const btnReset = document.getElementById('reset') as HTMLButtonElement;
const btnRotate = document.getElementById('rotate') as HTMLButtonElement;
const btnFlipH = document.getElementById('flip-h') as HTMLButtonElement;
const btnFlipV = document.getElementById('flip-v') as HTMLButtonElement;
const btnFullscreen = document.getElementById('fullscreen') as HTMLButtonElement;

// ── i18n ────────────────────────────────────────────────────────────────
interface Strings {
  loading: string;
  errorLoad: string;
  counter: (idx: number, total: number) => string;
  prev: string;
  next: string;
  zoomIn: string;
  zoomOut: string;
  reset: string;
  rotate: string;
  flipH: string;
  flipV: string;
  fullscreen: string;
  exitFullscreen: string;
}

const I18N: Record<string, Strings> = {
  en: {
    loading: 'Loading…',
    errorLoad: 'Failed to load image.',
    counter: (i, n) => `${i} / ${n}`,
    prev: 'Previous',
    next: 'Next',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    reset: 'Fit to window (0)',
    rotate: 'Rotate 90° (R)',
    flipH: 'Flip horizontal (H)',
    flipV: 'Flip vertical (V)',
    fullscreen: 'Toggle fullscreen (F)',
    exitFullscreen: 'Exit fullscreen',
  },
  zh: {
    loading: '加载中…',
    errorLoad: '图片加载失败。',
    counter: (i, n) => `${i} / ${n}`,
    prev: '上一张',
    next: '下一张',
    zoomIn: '放大',
    zoomOut: '缩小',
    reset: '适合窗口 (0)',
    rotate: '旋转 90° (R)',
    flipH: '水平翻转 (H)',
    flipV: '垂直翻转 (V)',
    fullscreen: '切换全屏 (F)',
    exitFullscreen: '退出全屏',
  },
};

let T: Strings = I18N.en;

function applyLocale() {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  for (const el of toolbarEl.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = el.dataset.i18nTitle as keyof Strings | undefined;
    if (key && typeof T[key] === 'string') {
      el.title = T[key] as string;
    }
  }
  // Re-render dynamic bits that depend on locale.
  updateCounter();
}

// ── Image-viewer-local state (controller owns zoom/pan/fit) ────────────
interface LocalState {
  /** 0 | 90 | 180 | 270 (clockwise). */
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** Siblings list (paths the user can navigate to with prev / next). */
  siblings: string[];
  /** Currently displayed path. */
  currentPath: string;
}

const state: LocalState = {
  rotation: 0,
  flipH: false,
  flipV: false,
  siblings: [],
  currentPath: '',
};

// ── Viewport controller (owns zoom/pan/fit/dragging) ───────────────────
const controller: ViewportController = createViewportController({
  imageEl,
  stageEl,
  getNaturalSize: () => {
    if (!imageEl.naturalWidth || !imageEl.naturalHeight) return null;
    return { w: imageEl.naturalWidth, h: imageEl.naturalHeight };
  },
  getViewportSize: () => {
    const r = stageEl.getBoundingClientRect();
    return { w: r.width, h: r.height };
  },
  getRotation: () => state.rotation,
  onChange: (s) => {
    imageEl.style.transform = buildTransform(
      s.pan, s.zoom, state.rotation, state.flipH, state.flipV,
    );
    zoomReadoutEl.textContent = `${Math.round(s.zoom * 100)}%`;
  },
});

// ── Apply transform (manual, for rotation/flip changes) ────────────────
// Rotation and flip change without going through `zoomBy`, so we apply the
// transform manually + ask the controller to recompute fit (rotation
// affects bounding box) and clamp the pan.
function applyManualTransform() {
  const s = controller.getState();
  imageEl.style.transform = buildTransform(
    s.pan, s.zoom, state.rotation, state.flipH, state.flipV,
  );
  zoomReadoutEl.textContent = `${Math.round(s.zoom * 100)}%`;
}

function rotateBy(delta: 90 | -90) {
  state.rotation = (((state.rotation + delta) % 360 + 360) % 360) as Rotation;
  controller.recomputeFitZoom();
  controller.clampCurrentPan();
  applyManualTransform();
}

// ── Keyboard ────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const action = keymapAction(e, {
    hasSiblings: state.siblings.length > 1,
    hasImage: controller.getState().hasImage,
  });
  if (!action) return;
  e.preventDefault();
  dispatchAction(action);
});

function dispatchAction(action: ReturnType<typeof keymapAction>) {
  if (!action) return;
  switch (action) {
    case 'prev':
      navigateSibling('prev');
      break;
    case 'next':
      navigateSibling('next');
      break;
    case 'first':
      navigateSibling('first');
      break;
    case 'last':
      navigateSibling('last');
      break;
    case 'zoomIn':
      controller.zoomIn();
      break;
    case 'zoomOut':
      controller.zoomOut();
      break;
    case 'reset':
      controller.resetToFit();
      break;
    case 'actualSize':
      controller.setActualSize();
      break;
    case 'rotate':
      rotateBy(90);
      break;
    case 'flipH':
      state.flipH = !state.flipH;
      applyManualTransform();
      break;
    case 'flipV':
      state.flipV = !state.flipV;
      applyManualTransform();
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
  }
}

// ── Toolbar wiring ──────────────────────────────────────────────────────
btnPrev.addEventListener('click', () => navigateSibling('prev'));
btnNext.addEventListener('click', () => navigateSibling('next'));
btnZoomOut.addEventListener('click', () => controller.zoomOut());
btnZoomIn.addEventListener('click', () => controller.zoomIn());
btnReset.addEventListener('click', () => controller.resetToFit());
btnRotate.addEventListener('click', () => rotateBy(90));
btnFlipH.addEventListener('click', () => {
  state.flipH = !state.flipH;
  applyManualTransform();
});
btnFlipV.addEventListener('click', () => {
  state.flipV = !state.flipV;
  applyManualTransform();
});
btnFullscreen.addEventListener('click', () => toggleFullscreen());

function setControlsEnabled(enabled: boolean) {
  for (const b of [
    btnZoomOut,
    btnZoomIn,
    btnReset,
    btnRotate,
    btnFlipH,
    btnFlipV,
    btnFullscreen,
  ]) {
    b.disabled = !enabled;
  }
  if (enabled) {
    controller.notifyImageLoaded();
  } else {
    controller.notifyImageCleared();
  }
}

function setNavEnabled(hasPrev: boolean, hasNext: boolean) {
  btnPrev.disabled = !hasPrev;
  btnNext.disabled = !hasNext;
}

function updateCounter() {
  if (state.siblings.length <= 1) {
    counterEl.textContent = state.siblings.length === 1 ? '1' : '—';
    return;
  }
  const idx = state.siblings.indexOf(state.currentPath);
  if (idx < 0) {
    counterEl.textContent = T.counter(0, state.siblings.length);
    return;
  }
  counterEl.textContent = T.counter(idx + 1, state.siblings.length);
}

// ── Sibling navigation ──────────────────────────────────────────────────
function navigateSibling(direction: SiblingDirection) {
  if (state.siblings.length === 0) return;
  const target = siblingTarget(state.siblings, state.currentPath, direction);
  if (!target || target === state.currentPath) return;
  window.whaleExt.postMessage({ type: 'requestFile', path: target });
  // Optimistically reflect the new position so the counter doesn't lag the
  // network round-trip; the host will echo the actual content next.
  state.currentPath = target;
  updateCounter();
  setNavEnabled(
    siblingTarget(state.siblings, state.currentPath, 'prev') !== null &&
      siblingTarget(state.siblings, state.currentPath, 'prev') !== state.currentPath,
    siblingTarget(state.siblings, state.currentPath, 'next') !== null &&
      siblingTarget(state.siblings, state.currentPath, 'next') !== state.currentPath
  );
}

// ── Fullscreen ──────────────────────────────────────────────────────────
function toggleFullscreen() {
  if (document.fullscreenElement) {
    void document.exitFullscreen?.();
  } else {
    void document.documentElement.requestFullscreen?.();
  }
}
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  const key = fs ? 'exitFullscreen' : 'fullscreen';
  btnFullscreen.title = (T[key] as string) ?? T.fullscreen;
});

// ── File loading ────────────────────────────────────────────────────────
function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot > 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

function mimeFor(filePath: string): string {
  const ext = extOf(filePath);
  switch (ext) {
    case 'svg':
      return 'image/svg+xml';
    case 'gif':
      return 'image/gif';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    case 'ico':
      return 'image/x-icon';
    case 'jpg':
    case 'jpeg':
    case 'tif':
    case 'tiff':
    default:
      return 'image/jpeg';
  }
}

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  loadingEl.hidden = true;
  imageEl.removeAttribute('src');
  setControlsEnabled(false);
}

function showLoading() {
  loadingEl.hidden = false;
  errorEl.hidden = true;
}

function hideOverlays() {
  loadingEl.hidden = true;
  errorEl.hidden = true;
}

function loadFile(filePath: string, content: string) {
  // New file → reset transform so the user sees the image in its natural
  // fit-to-window state, not whatever they had for the previous file.
  state.rotation = 0;
  state.flipH = false;
  state.flipV = false;
  state.currentPath = filePath;

  showLoading();
  const mime = mimeFor(filePath);
  const dataUrl = `data:${mime};base64,${content}`;
  imageEl.onload = () => {
    hideOverlays();
    setControlsEnabled(true);
    controller.recomputeFitZoom();
    controller.resetToFit();
  };
  imageEl.onerror = () => {
    showError(T.errorLoad);
  };
  imageEl.src = dataUrl;
}

// ── Host message dispatch ───────────────────────────────────────────────
window.whaleExt.onMessage((msg: HostMessage) => {
  switch (msg.type) {
    case 'fileContent':
      loadFile(msg.path, msg.content);
      break;
    case 'siblings': {
      state.siblings = msg.paths.slice();
      state.currentPath = msg.current;
      updateCounter();
      if (state.siblings.length > 1) {
        const prev = siblingTarget(state.siblings, state.currentPath, 'prev');
        const next = siblingTarget(state.siblings, state.currentPath, 'next');
        setNavEnabled(
          prev !== null && prev !== state.currentPath,
          next !== null && next !== state.currentPath
        );
      } else {
        setNavEnabled(false, false);
      }
      break;
    }
    case 'setTheme':
      document.body.setAttribute('data-theme', msg.theme);
      break;
    case 'setLocale':
      applyLocale();
      break;
    default:
      break;
  }
});

// ── Boot ────────────────────────────────────────────────────────────────
applyLocale();
document.body.setAttribute('data-theme', 'light');
setControlsEnabled(false);
window.whaleExt.postMessage({ type: 'ready' });