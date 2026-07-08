import './viewer.css';
// The emscripten factory: calling it with `{ wasmBinary }` instantiates the
// wasm from raw bytes (supplied by the host IPC bridge), bypassing the
// unreliable `fetch('whale-extension:/ …')` path. Same trick as cad-viewer's
// occt loader.
import libheifFactory from 'libheif-js/libheif-wasm/libheif.js';

/**
 * heic-viewer: decodes HEIC/HEIF (iPhone photos) in-iframe via the
 * libheif-js wasm. Chromium cannot decode HEIC natively, and sharp's
 * bundled libvips lacks libde265 — so neither `<img>` nor the thumbnail
 * pipeline can handle it. The wasm bytes come from the host via
 * requestHeicWasm (see ExtensionHost); we decode to RGBA on a canvas
 * and show the result via a JPEG blob URL.
 *
 * HEIC is deliberately NOT in whale-meta's IMAGE_EXT: that set drives
 * both sharp thumbnails and the MediaLightbox double-click route, neither
 * of which can render HEIC. Keeping it in its own HEIC_EXT (BINARY_EXT
 * only) routes the double-click through selectExtension → here.
 *
 * Batch 1 (2026-07-02) — zoom / pan / fit-to-window via the shared
 * `createViewportController` from `../shared/zoom`. heic-viewer has no
 * rotation / flip / fullscreen (not in §四 experience plan); the
 * controller is called with `getRotation = () => 0` so fit math is
 * rotation-free.
 */

// libheif-js ships only low-level emscripten types (libheif.d.ts); the
// high-level HeifDecoder / HeifImage wrapper lives in the factory's closure, so
// we type just the surface we use at the boundary and cast the factory result.
interface HeifImageLike {
 get_width(): number;
 get_height(): number;
 has_alpha_channel(): boolean;
 display(
 target: { data: Uint8ClampedArray },
 cb: (data: unknown) => void
 ): void;
 free(): void;
}
interface LibheifLike {
 HeifDecoder: new () => { decode(data: Uint8Array): HeifImageLike[] };
}

import { buildTransform, createViewportController, type ViewportController } from '../shared/zoom';
import { keymapAction } from '../shared/keymap';

interface Strings {
 loading: string;
 decoding: string;
 decodeError: string;
 systemApp: string;
 zoomOut: string;
 zoomReset: string;
 zoomIn: string;
 zoomFitWidth: string;
}

const I18N: Record<string, Strings> = {
 en: {
 loading: 'Loading…',
 decoding: 'Decoding…',
 decodeError: 'Failed to decode HEIC image: {msg}',
 systemApp: 'Open with system app',
 zoomOut: 'Zoom out',
 zoomReset: 'Fit to window (0)',
 zoomIn: 'Zoom in',
 zoomFitWidth: 'Fit',
 },
 zh: {
 loading: '加载中…',
 decoding: '解码中…',
 decodeError: '解码 HEIC 图片失败:{msg}',
 systemApp: '用系统应用打开',
 zoomOut: '缩小',
 zoomReset: '适合窗口 (0)',
 zoomIn: '放大',
 zoomFitWidth: '适应',
 },
};

let T: Strings = I18N.en;

/** UI element typed getter; throws if a required element is missing. */
function getEl<T extends HTMLElement>(id: string, _cls: new () => T): T {
 const el = document.getElementById(id);
 if (!el) throw new Error(`Missing element #${id}`);
 return el as T;
}

// --- DOM refs ---
const fileNameEl = getEl('file-name', HTMLSpanElement);
const statusEl = getEl('status', HTMLSpanElement);
const openSystemBtn = getEl('open-system', HTMLButtonElement);
const imageEl = getEl('image', HTMLImageElement);
const errorEl = getEl('error', HTMLDivElement);
const errorMessageEl = getEl('error-message', HTMLParagraphElement);
const openNativeBtn = getEl('btn-open-native', HTMLButtonElement);
const containerEl = getEl('container', HTMLDivElement);
const zoomOutBtn = getEl('zoom-out', HTMLButtonElement);
const zoomResetBtn = getEl('zoom-reset', HTMLButtonElement);
const zoomInBtn = getEl('zoom-in', HTMLButtonElement);
const zoomPctEl = getEl('zoom-pct', HTMLSpanElement);

// --- State ---
let loadToken = 0; // bumped per file; stale decodes bail by re-checking this
let currentPath: string | null = null;
let currentObjectUrl: string | null = null;

// --- Viewport controller (shared with image-viewer) ---
const controller: ViewportController = createViewportController({
 imageEl,
 stageEl: containerEl,
 getNaturalSize: () => {
 if (!imageEl.naturalWidth || !imageEl.naturalHeight) return null;
 return { w: imageEl.naturalWidth, h: imageEl.naturalHeight };
 },
 getViewportSize: () => {
 const r = containerEl.getBoundingClientRect();
 return { w: r.width, h: r.height };
 },
 // heic-viewer doesn't rotate (no §四 plan), but pass a constant getter
 // so the controller's API matches image-viewer's usage.
 getRotation: () => 0,
 onChange: (s) => {
 imageEl.style.transform = buildTransform(
 s.pan, s.zoom, 0, false, false,
 );
 if (s.hasImage) {
 zoomPctEl.textContent = `${Math.round(s.zoom * 100)}%`;
 } else {
 zoomPctEl.textContent = '';
 }
 // Toolbar buttons track `hasImage` so the user can't fire zoom
 // before the first decode finishes.
 zoomOutBtn.disabled = !s.hasImage;
 zoomInBtn.disabled = !s.hasImage;
 zoomResetBtn.disabled = !s.hasImage;
 },
});

// --- Helpers ---
function base64ToBytes(b64: string): Uint8Array {
 const binary = window.atob(b64);
 const len = binary.length;
 const bytes = new Uint8Array(len);
 for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
 return bytes;
}

function detectInitialTheme(): 'light' | 'dark' {
 try {
 if (
 typeof window !== 'undefined' &&
 typeof window.matchMedia === 'function' &&
 window.matchMedia('(prefers-color-scheme: dark)').matches
 ) {
 return 'dark';
 }
 } catch {
 // jsdom / older browsers: fall through to 'light'
 }
 return 'light';
}

function applyTheme(theme: 'light' | 'dark') {
 document.body.setAttribute('data-theme', theme);
}

function applyLocale() {
 T = window.whaleExt.t(I18N);
 document.documentElement.lang = window.whaleExt.locale;
 openSystemBtn.textContent = T.systemApp;
 openNativeBtn.textContent = T.systemApp;
 zoomOutBtn.setAttribute('aria-label', T.zoomOut);
 zoomOutBtn.setAttribute('title', T.zoomOut);
 zoomInBtn.setAttribute('aria-label', T.zoomIn);
 zoomInBtn.setAttribute('title', T.zoomIn);
 zoomResetBtn.setAttribute('aria-label', T.zoomReset);
 zoomResetBtn.setAttribute('title', T.zoomReset);
 zoomResetBtn.textContent = T.zoomFitWidth;
}

// --- Error / system-open UI ---
function setSystemOpen(path: string | null) {
 openSystemBtn.hidden = path == null;
 if (path) openNativeBtn.dataset.path = path;
}

function showError(message: string, path: string | null) {
 errorMessageEl.textContent = message;
 errorEl.classList.remove('hidden');
 setSystemOpen(path);
 controller.notifyImageCleared();
}

function hideError() {
 errorEl.classList.add('hidden');
}

// --- libheif-js wasm bridge (mirrors cad-viewer's occt loader) ---
let heicWasmReqId = 0;
const pendingHeicWasm = new Map<
 string,
 { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }
>();

function requestHeicWasm(): Promise<ArrayBuffer> {
 const requestId = `h${(heicWasmReqId += 1)}`;
 return new Promise<ArrayBuffer>((resolve, reject) => {
 pendingHeicWasm.set(requestId, { resolve, reject });
 window.whaleExt.postMessage({ type: 'requestHeicWasm', requestId });
 });
}

let libheifPromise: Promise<LibheifLike> | null = null;

function getLibheif(): Promise<LibheifLike> {
 if (!libheifPromise) {
 libheifPromise = requestHeicWasm()
 // libheif-js's factory returns the ready module SYNCHRONOUSLY (unlike
 // occt-import-js, which resolves a Promise): with `wasmBinary` the wasm
 // instantiates sync, so the factory call itself needs no `.then`.
 .then(
 (wasmBinary) => libheifFactory({ wasmBinary }) as unknown as LibheifLike
 )
 .catch((e: unknown) => {
 libheifPromise = null; // allow a retry on the next file
 throw e;
 });
 }
 return libheifPromise;
}

// --- Decode + render ---
async function decodeAndShow(content: string, token: number): Promise<void> {
 await getLibheif();
 if (token !== loadToken) return; // superseded by a newer file
 statusEl.textContent = T.decoding;

 // decode() is synchronous and CPU-heavy inside the wasm; yield once so the
 // "Decoding…" status actually paints before the blocking call runs.
 await new Promise((r) => setTimeout(r, 0));
 if (token !== loadToken) return;

 const bytes = base64ToBytes(content);
 const libheif = await getLibheif();
 if (token !== loadToken) return;

 const decoder = new libheif.HeifDecoder();
 const images = decoder.decode(bytes);
 if (token !== loadToken) return;
 if (!images || images.length === 0) {
 throw new Error('no decodable image found in this file');
 }
 // MVP: only the primary image is shown. A HEIC can hold a burst / derived-
 // image chain (images.length > 1); a thumbnail strip is a future enhancement.
 const image = images[0];
 try {
 const width = image.get_width();
 const height = image.get_height();
 if (!width || !height) throw new Error('image has no dimensions');

 const canvas = document.createElement('canvas');
 canvas.width = width;
 canvas.height = height;
 const ctx = canvas.getContext('2d');
 if (!ctx) throw new Error('2D canvas context unavailable');
 const imageData = ctx.createImageData(width, height);
 // libheif auto-applies EXIF orientation during display(), so the RGBA is
 // already upright (unlike JPEG, where sharp must `.rotate()`).
 await new Promise<void>((resolve, reject) => {
 image.display(imageData, (result) => {
 if (result) resolve();
 else reject(new Error('libheif decode returned no data'));
 });
 });
 if (token !== loadToken) return;
 ctx.putImageData(imageData, 0, 0);

 // Re-encode to JPEG for display: photos are continuous-tone, so JPEG at
 // 0.92 is visually lossless for preview yet far smaller than PNG (a 12 MP
 // PNG would be tens of MB). HEIC alpha is lost — acceptable for photos.
 const blob = await new Promise<Blob | null>((resolve) =>
 canvas.toBlob(resolve, 'image/jpeg', 0.92)
 );
 if (token !== loadToken) return;
 if (!blob) throw new Error('failed to encode decoded image');

 if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
 currentObjectUrl = URL.createObjectURL(blob);
 imageEl.onload = () => {
 // Bail if a newer file has been requested — the previous onload
 // arriving late must not reset transform state.
 if (token !== loadToken) return;
 statusEl.textContent = '';
 hideError();
 controller.notifyImageLoaded();
 };
 imageEl.onerror = () => {
 if (token !== loadToken) return;
 showError(
 T.decodeError.replace('{msg}', 'image failed to render'),
 currentPath,
 );
 };
 imageEl.src = currentObjectUrl;
 } finally {
 image.free();
 }
}

function renderContent(path: string, content: string) {
 loadToken += 1;
 const token = loadToken;
 currentPath = path;
 setSystemOpen(path);
 hideError();
 controller.notifyImageCleared();
 fileNameEl.textContent = path.split(/[\\/]/).pop() || path;
 imageEl.alt = path.split(/[\\/]/).pop() || 'image';
 if (currentObjectUrl) {
 URL.revokeObjectURL(currentObjectUrl);
 currentObjectUrl = null;
 }
 imageEl.removeAttribute('src');
 statusEl.textContent = T.loading;
 void decodeAndShow(content, token).catch((e: unknown) => {
 if (token !== loadToken) return; // a newer file won; drop this error
 statusEl.textContent = '';
 showError(
 T.decodeError.replace(
 '{msg}',
 e instanceof Error ? e.message : String(e)
 ),
 path
 );
 });
}

function openCurrentInSystemApp() {
 const target = currentPath;
 if (!target) return;
 window.whaleExt.postMessage({ type: 'openLinkExternally', url: target });
}

openSystemBtn.addEventListener('click', openCurrentInSystemApp);
openNativeBtn.addEventListener('click', openCurrentInSystemApp);

// --- Toolbar wiring ---
zoomOutBtn.addEventListener('click', () => controller.zoomOut());
zoomInBtn.addEventListener('click', () => controller.zoomIn());
zoomResetBtn.addEventListener('click', () => controller.resetToFit());

// --- Keyboard ---
window.addEventListener('keydown', (e) => {
 const action = keymapAction(e, {
 hasSiblings: false, // heic-viewer doesn't navigate siblings
 hasImage: controller.getState().hasImage,
 });
 if (!action) return;
 // heic-viewer only consumes zoom/fit actions. Everything else (rotate,
 // flip, fullscreen, prev/next) is dropped on the floor.
 if (action === 'zoomIn') {
 e.preventDefault();
 controller.zoomIn();
 } else if (action === 'zoomOut') {
 e.preventDefault();
 controller.zoomOut();
 } else if (action === 'reset') {
 e.preventDefault();
 controller.resetToFit();
 } else if (action === 'actualSize') {
 e.preventDefault();
 controller.setActualSize();
 }
});

// --- Host message handling ---
window.whaleExt.onMessage((msg) => {
 switch (msg.type) {
 case 'fileContent':
 if (msg.encoding === 'base64') {
 renderContent(msg.path, msg.content);
 }
 break;
 case 'setTheme':
 applyTheme(msg.theme);
 break;
 case 'heicWasm': {
 const pending = pendingHeicWasm.get(msg.requestId);
 if (!pending) break;
 pendingHeicWasm.delete(msg.requestId);
 if (msg.data) {
 pending.resolve(msg.data);
 } else {
 pending.reject(new Error(msg.error || 'Failed to load HEIC wasm'));
 }
 break;
 }
 default:
 break;
 }
});

window.whaleExt.onLocale(() => applyLocale());
window.whaleExt.postMessage({ type: 'ready' });

// --- Initial paint ---
// Order matters (matches html-viewer):
// 1. apply OS-guessed theme so first frame matches the host (no flash)
// 2. applyLocale() seeds labels
// 3. The controller is created at module top with empty state; nothing to
// do here for it.
applyTheme(detectInitialTheme());
applyLocale();
// Initial render: toolbar buttons disabled until first image decodes.
// (onChange with the controller's initial state has already run.)
controller.notifyImageCleared();