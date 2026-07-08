import './viewer.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DxfParser } from 'dxf-parser';
import type { IDxf, IEntity, IPoint } from 'dxf-parser';
import occtimportjs, {
  type OcctResult,
  type OcctMesh,
  type OcctNode,
} from 'occt-import-js';

/** Tier 0 MVP: STL / OBJ / GLB / GLTF / PLY, all parsed in-iframe with Three.js
 *  native loaders. The host sends the file as base64 (`fileContent`); no
 *  main-process conversion is needed. DWG / STEP / IGES / BREP / DXF land in
 *  later tiers (see docs/07-extensions.md §九). */

interface Strings {
  loading: string;
  webglUnsupported: string;
  parseError: string;
  unsupportedFormat: string;
  resetView: string;
  wireframeOn: string;
  wireframeOff: string;
  systemApp: string;
  vertices: string;
  view2D: string;
  view3D: string;
}

const I18N: Record<string, Strings> = {
  en: {
    loading: 'Loading…',
    webglUnsupported:
      'WebGL is not available in this context. CAD Viewer cannot render 3D models.',
    parseError: 'Failed to load CAD model: {msg}',
    unsupportedFormat: 'Unsupported CAD format for this file.',
    resetView: 'Reset view',
    wireframeOn: 'Show solid',
    wireframeOff: 'Show wireframe',
    systemApp: 'Open with system app',
    vertices: '{n} vertices',
    view2D: '2D view',
    view3D: '3D view',
  },
  zh: {
    loading: '加载中…',
    webglUnsupported: '当前环境不支持 WebGL,CAD 查看器无法渲染三维模型。',
    parseError: '加载 CAD 模型失败:{msg}',
    unsupportedFormat: '此文件的 CAD 格式暂不支持。',
    resetView: '重置视角',
    wireframeOn: '实体显示',
    wireframeOff: '线框显示',
    systemApp: '用系统应用打开',
    vertices: '{n} 个顶点',
    view2D: '二维视图',
    view3D: '三维视图',
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
const resetBtn = getEl('reset-view', HTMLButtonElement);
const viewModeBtn = getEl('view-mode', HTMLButtonElement);
const wireframeBtn = getEl('wireframe', HTMLButtonElement);
const openSystemBtn = getEl('open-system', HTMLButtonElement);
const viewerEl = getEl('viewer', HTMLElement);
const errorEl = getEl('error', HTMLDivElement);
const errorMessageEl = getEl('error-message', HTMLParagraphElement);
const openNativeBtn = getEl('btn-open-native', HTMLButtonElement);

// --- Three.js state ---
let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
let perspectiveCamera: THREE.PerspectiveCamera;
let orthoCamera: THREE.OrthographicCamera | null = null;
let controls: OrbitControls;
let grid: THREE.GridHelper;
let grid2d: THREE.GridHelper;
let currentModel: THREE.Object3D | null = null;
let loadToken = 0; // bumped on each new file; stale async parses check this
let wireframe = false;
let theme: 'light' | 'dark' = 'light';
let currentPath: string | null = null;
let is2D = false;
let userForced2D: boolean | null = null; // null = auto-detect, true/false = user override

const BG: Record<'light' | 'dark', number> = { light: 0xf0f0f0, dark: 0x1e1e1e };

// --- Helpers ---
function base64ToBytes(b64: string): Uint8Array {
  const binary = window.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fresh ArrayBuffer over exactly `bytes` (TS 5.9 tightens ArrayBufferLike —
 *  `bytes.buffer.slice()` widens to `ArrayBuffer | SharedArrayBuffer`). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

// --- i18n / theme ---
function applyTheme(next: 'light' | 'dark') {
  theme = next;
  document.body.setAttribute('data-theme', next);
  if (scene) scene.background = new THREE.Color(BG[next]);
}

function applyLocale() {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  resetBtn.textContent = T.resetView;
  wireframeBtn.textContent = wireframe ? T.wireframeOn : T.wireframeOff;
  openSystemBtn.textContent = T.systemApp;
  openNativeBtn.textContent = T.systemApp;
  updateViewModeButton();
}

// --- Error UI ---
function setSystemOpen(path: string | null) {
  openSystemBtn.hidden = path == null;
  if (path) openNativeBtn.dataset.path = path;
}

function showError(message: string, path: string | null) {
  errorMessageEl.textContent = message;
  errorEl.classList.remove('hidden');
  setSystemOpen(path);
}

function hideError() {
  errorEl.classList.add('hidden');
}

// --- Three.js setup ---
function webglAvailable(): boolean {
  const testCanvas = document.createElement('canvas');
  const gl =
    testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
  return !!gl;
}

function initThree(): boolean {
  if (!webglAvailable()) {
    showError(T.webglUnsupported, currentPath);
    return false;
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG[theme]);

  perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  perspectiveCamera.position.set(0, 0, 5);
  camera = perspectiveCamera;

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    showError(T.webglUnsupported, currentPath);
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewerEl.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(5, 10, 7);
  scene.add(dir);

  grid = new THREE.GridHelper(10, 10, 0x888888, 0x888888);
  const gridMat = grid.material as THREE.LineBasicMaterial;
  gridMat.transparent = true;
  gridMat.opacity = 0.5;
  scene.add(grid);

  // A flat XY-plane grid for 2D formats (DXF/DWG). Hidden by default; toggled
  // by applyViewMode. It uses the same material settings as the 3D grid.
  grid2d = new THREE.GridHelper(10, 10, 0x888888, 0x888888);
  grid2d.rotation.x = Math.PI / 2;
  const grid2dMat = grid2d.material as THREE.LineBasicMaterial;
  grid2dMat.transparent = true;
  grid2dMat.opacity = 0.5;
  grid2d.visible = false;
  scene.add(grid2d);

  resize();
  animate();

  new ResizeObserver(() => resize()).observe(viewerEl);
  return true;
}

function resize() {
  if (!renderer) return;
  const w = viewerEl.clientWidth || 1;
  const h = viewerEl.clientHeight || 1;
  renderer.setSize(w, h, false);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    // Preserve the orthographic frustum's center and half-height; adjust width
    // to the new aspect ratio so the 2D view doesn't stretch.
    const cx = (camera.left + camera.right) / 2;
    const cy = (camera.top + camera.bottom) / 2;
    const halfH = (camera.top - camera.bottom) / 2;
    const halfW = halfH * (w / h);
    camera.left = cx - halfW;
    camera.right = cx + halfW;
    camera.top = cy + halfH;
    camera.bottom = cy - halfH;
    camera.updateProjectionMatrix();
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// --- 2D / 3D view mode handling ---

function is2DFormat(ext: string): boolean {
  return ext === 'dxf' || ext === 'dwg';
}

function updateViewModeButton() {
  if (!viewModeBtn) return;
  viewModeBtn.textContent = is2D ? T.view3D : T.view2D;
  viewModeBtn.hidden = !currentPath || !is2DFormat(extOf(currentPath));
}

function applyViewMode(twoD: boolean) {
  if (is2D === twoD && controls) return;
  is2D = twoD;

  if (controls) {
    controls.dispose();
  }

  if (is2D) {
    if (!orthoCamera) {
      orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    }
    camera = orthoCamera;
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    grid.visible = false;
    grid2d.visible = true;
    wireframeBtn.disabled = true;
  } else {
    camera = perspectiveCamera;
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    grid.visible = true;
    grid2d.visible = false;
    wireframeBtn.disabled = false;
  }

  updateViewModeButton();
  if (currentModel) frameObject(currentModel);
  resize();
}

// --- Model loading ---
function wrapGeometry(geom: THREE.BufferGeometry): THREE.Mesh {
  const hasVertexColors = !!geom.attributes.color;
  if (!geom.attributes.normal) geom.computeVertexNormals();
  geom.computeBoundingBox();
  const material = new THREE.MeshStandardMaterial({
    color: 0x9aa0a6,
    metalness: 0.05,
    roughness: 0.75,
    vertexColors: hasVertexColors,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geom, material);
}

// --- DXF (Tier 1) ---
// dxf-parser yields IEntity[]; we convert each into a Three.js line / sprite.
// Coverage: LINE / CIRCLE / ARC / LWPOLYLINE / POLYLINE / TEXT / MTEXT / INSERT
// (basic block). SPLINE / ELLIPSE / HATCH / DIMENSION etc. are skipped
// (preview-level — see docs/07-extensions.md §九).

interface DxfLineEntity extends IEntity {
  vertices: IPoint[];
}
interface DxfArcishEntity extends IEntity {
  center: IPoint;
  radius: number;
  startAngle: number;
  endAngle: number;
}
interface DxfPolylineEntity extends IEntity {
  vertices: IPoint[];
  shape: boolean;
}
interface DxfTextEntity extends IEntity {
  startPoint: IPoint;
  textHeight: number;
  rotation: number;
  text: string;
}
interface DxfMtextEntity extends IEntity {
  position: IPoint;
  height: number;
  rotation: number;
  text: string;
}
interface DxfInsertEntity extends IEntity {
  name: string;
  position: IPoint;
  rotation: number;
  xScale: number;
  yScale: number;
  zScale: number;
}

const DXF_CIRCLE_SEGMENTS = 64;
const DEFAULT_DXF_COLOR = new THREE.Color(0x9aa0a6);

/** ACI (AutoCAD Color Index) → THREE.Color. Indices 1-9 and the gray ramp
 *  (250-255) are exact; the mid-range (10-249) uses an approximate hue ramp
 *  (good enough for preview). BYLAYER / layer-color resolution is deferred. */
function aciToColor(aci: number): THREE.Color {
  switch (aci) {
    case 1: return new THREE.Color(0xff0000); // red
    case 2: return new THREE.Color(0xffff00); // yellow
    case 3: return new THREE.Color(0x00ff00); // green
    case 4: return new THREE.Color(0x00ffff); // cyan
    case 5: return new THREE.Color(0x0000ff); // blue
    case 6: return new THREE.Color(0xff00ff); // magenta
    case 7: // foreground: dark on light, light on dark
      return new THREE.Color(theme === 'dark' ? 0xeeeeee : 0x222222);
    case 8: return new THREE.Color(0x808080);
    case 9: return new THREE.Color(0xc0c0c0);
    default: break;
  }
  if (aci >= 250 && aci <= 255) {
    const g = 0.25 + ((aci - 250) / 5) * 0.55;
    return new THREE.Color(g, g, g);
  }
  if (aci >= 10 && aci <= 249) {
    return new THREE.Color().setHSL(((aci - 10) % 24) / 24, 0.65, 0.5);
  }
  return DEFAULT_DXF_COLOR.clone(); // 0 (BYBLOCK), 256 (BYLAYER), invalid
}

function tessellateArc(
  center: IPoint,
  radius: number,
  startAngle: number,
  endAngle: number
): THREE.Vector3[] {
  let sa = startAngle || 0;
  let ea = endAngle || 0;
  if (ea <= sa) ea += Math.PI * 2;
  const span = ea - sa;
  const segs = Math.max(
    8,
    Math.min(128, Math.ceil((span / (Math.PI * 2)) * DXF_CIRCLE_SEGMENTS))
  );
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const a = sa + (span * i) / segs;
    pts.push(
      new THREE.Vector3(
        center.x + radius * Math.cos(a),
        center.y + radius * Math.sin(a),
        center.z
      )
    );
  }
  return pts;
}

/** Strip MTEXT formatting codes (\P newline, \f font, braces, alignment). */
function cleanMtext(text: string): string {
  return text
    .replace(/\\P/gi, '\n')
    .replace(/\\[Aa][0-9];/g, '')
    .replace(/\\f[^;]*;/gi, '')
    .replace(/\\[^;]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

/** Render text as a canvas-texture Sprite (no extra font dep). Position/rotation
 *  approximate the DXF anchor — preview-grade. */
function textToSprite(
  text: string,
  point: IPoint | undefined,
  height: number,
  rotationDeg: number,
  color: THREE.Color
): THREE.Sprite | null {
  if (!text || !point) return null;
  const fontSize = 64;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = fontSize + 8;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${fontSize}px sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + 8;
  canvas.width = width; // resize resets context state
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = `#${color.getHexString()}`;
  ctx.fillText(text, 4, 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  const aspect = canvas.width / canvas.height;
  const h = height || 1;
  sprite.scale.set(h * aspect, h, 1);
  // Place sprite so its bottom-left ≈ the text anchor, accounting for rotation.
  const rad = THREE.MathUtils.degToRad(rotationDeg);
  const halfW = (h * aspect) / 2;
  const halfH = h / 2;
  sprite.position.set(
    point.x + halfW * Math.cos(rad) - halfH * Math.sin(rad),
    point.y + halfW * Math.sin(rad) + halfH * Math.cos(rad),
    point.z
  );
  mat.rotation = rad;
  return sprite;
}

/** Convert one DXF entity to a Three.js object, or null if unsupported. */
function dxfEntityToObject(
  entity: IEntity,
  blocks: IDxf['blocks'],
  depth: number
): THREE.Object3D | null {
  const aci = entity.color || entity.colorIndex || 0;
  const color = aciToColor(aci);
  switch (entity.type) {
    case 'LINE': {
      const e = entity as DxfLineEntity;
      const pts = (e.vertices || []).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      if (pts.length < 2) return null;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    }
    case 'CIRCLE':
    case 'ARC': {
      const e = entity as DxfArcishEntity;
      if (!e.center || !e.radius) return null;
      // CIRCLE is a full circle (start/end usually 0/2π); ARC is a partial arc.
      const full = entity.type === 'CIRCLE';
      const pts = tessellateArc(
        e.center,
        e.radius,
        full ? 0 : e.startAngle,
        full ? Math.PI * 2 : e.endAngle
      );
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      return new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color }));
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const e = entity as DxfPolylineEntity;
      const pts = (e.vertices || []).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      if (pts.length < 2) return null;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      return e.shape
        ? new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color }))
        : new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    }
    case 'TEXT': {
      const e = entity as DxfTextEntity;
      return textToSprite(e.text, e.startPoint, e.textHeight || 1, e.rotation || 0, color);
    }
    case 'MTEXT': {
      const e = entity as DxfMtextEntity;
      return textToSprite(
        cleanMtext(e.text || ''),
        e.position,
        e.height || 1,
        e.rotation || 0,
        color
      );
    }
    case 'INSERT': {
      if (depth >= 3) return null; // cap nested-block recursion
      const e = entity as DxfInsertEntity;
      const block = blocks?.[e.name];
      if (!block?.entities) return null;
      const sub = new THREE.Group();
      for (const subEnt of block.entities) {
        const obj = dxfEntityToObject(subEnt, blocks, depth + 1);
        if (obj) sub.add(obj);
      }
      sub.position.set(e.position?.x || 0, e.position?.y || 0, e.position?.z || 0);
      sub.rotation.z = THREE.MathUtils.degToRad(e.rotation || 0);
      sub.scale.set(e.xScale || 1, e.yScale || 1, e.zScale || 1);
      return sub;
    }
    default:
      return null; // SPLINE / ELLIPSE / HATCH / DIMENSION / … → skip
  }
}

function buildDxfGroup(dxf: IDxf): THREE.Group {
  const group = new THREE.Group();
  for (const entity of dxf.entities || []) {
    const obj = dxfEntityToObject(entity, dxf.blocks, 0);
    if (obj) group.add(obj);
  }
  return group;
}

// --- DWG (Tier 2) ---
// DWG needs an external converter (LibreDWG dwg2dxf / ODA File Converter),
// which runs in the main process on the file's path (like office-viewer). The
// host returns DXF bytes, which we parse with DxfParser + render via the
// Tier-1 buildDxfGroup above — no separate DWG renderer.
let dwgReqId = 0;
const pendingDwgConversions = new Map<
  string,
  { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }
>();

function requestDwgConvert(filePath: string): Promise<ArrayBuffer> {
  const requestId = `d${(dwgReqId += 1)}`;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pendingDwgConversions.set(requestId, { resolve, reject });
    window.whaleExt.postMessage({ type: 'requestDwgConvert', requestId, path: filePath });
  });
}

// --- STEP / IGES / BREP (Tier 1.5) ---
// occt-import-js (OpenCASCADE wasm) parses these into a three.js-compatible
// JSON: root scene graph + meshes[] with position/normal/index arrays + color.
// The wasm is fetched once (lazy) from the extension's dist folder.

let occtPromise: Promise<Awaited<ReturnType<typeof occtimportjs>>> | null = null;

// occt's wasm comes from the host (not fetch): `whale-extension://` fetch is
// unreliable in this Electron build, so we request the bytes over the message
// bridge and hand them to emscripten as `wasmBinary` (skips fetch/locateFile).
let cadWasmReqId = 0;
const pendingCadWasm = new Map<
  string,
  { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }
>();

function requestCadWasm(): Promise<ArrayBuffer> {
  const requestId = `w${(cadWasmReqId += 1)}`;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pendingCadWasm.set(requestId, { resolve, reject });
    window.whaleExt.postMessage({ type: 'requestCadWasm', requestId });
  });
}

function getOcct() {
  if (!occtPromise) {
    occtPromise = requestCadWasm()
      .then((wasmBinary) => occtimportjs({ wasmBinary }))
      .catch((e: unknown) => {
        occtPromise = null; // allow a retry on the next file
        throw e;
      });
  }
  return occtPromise;
}

function buildOcctMesh(mesh: OcctMesh): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  const pos = mesh.attributes?.position?.array ?? [];
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nor = mesh.attributes?.normal?.array;
  if (nor && nor.length) {
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  } else {
    geo.computeVertexNormals();
  }
  const idx = mesh.index?.array;
  if (idx && idx.length) geo.setIndex(idx);
  const color = mesh.color
    ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2])
    : new THREE.Color(0x9aa0a6);
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, material);
}

function buildOcctNode(node: OcctNode, meshes: OcctMesh[]): THREE.Object3D {
  const obj = new THREE.Group();
  if (node.name) obj.name = node.name;
  for (const idx of node.meshes ?? []) {
    const m = meshes[idx];
    if (m) obj.add(buildOcctMesh(m));
  }
  for (const child of node.children ?? []) {
    obj.add(buildOcctNode(child, meshes));
  }
  return obj;
}

function buildOcctGroup(result: OcctResult): THREE.Group {
  const group = new THREE.Group();
  if (result.root) group.add(buildOcctNode(result.root, result.meshes ?? []));
  return group;
}

/** Parse the bytes by extension. GLB/GLTF is async (callback loader).
 *  `path` is needed by DWG (path-based external conversion). */
function parseModel(
  ext: string,
  bytes: Uint8Array,
  path: string
): Promise<THREE.Object3D> {
  const buffer = toArrayBuffer(bytes);
  if (ext === 'stl') {
    return Promise.resolve(wrapGeometry(new STLLoader().parse(buffer)));
  }
  if (ext === 'ply') {
    return Promise.resolve(wrapGeometry(new PLYLoader().parse(buffer)));
  }
  if (ext === 'obj') {
    const text = new TextDecoder().decode(bytes);
    return Promise.resolve(new OBJLoader().parse(text));
  }
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    // .gltf is JSON text (may reference an external .bin we don't have — it
    // will surface as a parse error, which we show inline). .glb is binary.
    const data: ArrayBuffer | string =
      ext === 'gltf' ? new TextDecoder().decode(bytes) : buffer;
    return new Promise<THREE.Object3D>((resolve, reject) => {
      loader.parse(
        data,
        '',
        (gltf) => resolve(gltf.scene),
        (err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }
  if (ext === 'dxf') {
    const text = new TextDecoder().decode(bytes);
    const dxf = new DxfParser().parseSync(text);
    if (!dxf) throw new Error('Failed to parse DXF');
    return Promise.resolve(buildDxfGroup(dxf));
  }
  if (ext === 'dwg') {
    // External converter (main process) → DXF bytes → reuse the DXF renderer.
    return requestDwgConvert(path).then((data) => {
      const text = new TextDecoder().decode(new Uint8Array(data));
      const dxf = new DxfParser().parseSync(text);
      if (!dxf) throw new Error('DWG converter produced an unreadable DXF');
      return buildDxfGroup(dxf);
    });
  }
  if (
    ext === 'step' ||
    ext === 'stp' ||
    ext === 'iges' ||
    ext === 'igs' ||
    ext === 'brep'
  ) {
    return getOcct().then((occt) => {
      const result =
        ext === 'brep'
          ? occt.ReadBrepFile(bytes, null)
          : ext === 'iges' || ext === 'igs'
            ? occt.ReadIgesFile(bytes, null)
            : occt.ReadStepFile(bytes, null);
      if (!result || !result.success) {
        throw new Error('OCCT could not parse this CAD file');
      }
      return buildOcctGroup(result);
    });
  }
  return Promise.reject(new Error(T.unsupportedFormat));
}

function disposeModel() {
  if (!currentModel) return;
  scene.remove(currentModel);
  currentModel.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    }
  });
  currentModel = null;
}

function countVertices(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const pos = mesh.geometry.attributes.position;
      if (pos) n += pos.count;
      return;
    }
    const line = child as THREE.Line;
    if (child instanceof THREE.Line && line.geometry) {
      const pos = line.geometry.attributes.position;
      if (pos) n += pos.count;
    }
  });
  return n;
}

function setWireframeState(on: boolean) {
  if (!currentModel) return;
  currentModel.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      mat.forEach((m) => {
        (m as THREE.MeshStandardMaterial).wireframe = on;
      });
    } else if (mat) {
      (mat as THREE.MeshStandardMaterial).wireframe = on;
    }
  });
}

/** Position the camera so the whole model is visible; scale the floor grid. */
function frameObject(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  if (camera instanceof THREE.OrthographicCamera) {
    // 2D framing: look straight down the Z axis, fit XY bounding box with
    // padding, and keep the grid on the XY plane.
    const padding = 1.05;
    const halfH = (size.y * padding) / 2;
    const aspect = viewerEl.clientWidth / viewerEl.clientHeight || 1;
    const halfW = halfH * aspect;
    camera.left = center.x - halfW;
    camera.right = center.x + halfW;
    camera.top = center.y + halfH;
    camera.bottom = center.y - halfH;
    camera.near = -1000;
    camera.far = 1000;
    camera.position.set(center.x, center.y, 10);
    camera.lookAt(center.x, center.y, 0);
    camera.updateProjectionMatrix();
    controls.target.set(center.x, center.y, 0);

    grid2d.scale.setScalar(maxDim);
    grid2d.position.set(center.x, center.y, 0);
  } else {
    const fov = (camera.fov * Math.PI) / 180;
    const distance = Math.max((maxDim / 2) / Math.tan(fov / 2) * 1.6, 0.001);

    camera.near = Math.max(distance / 100, 1e-4);
    camera.far = distance * 1000;
    camera.updateProjectionMatrix();
    camera.position.set(center.x, center.y + maxDim * 0.2, center.z + distance);
    camera.lookAt(center);
    controls.target.copy(center);

    grid.scale.setScalar(maxDim);
    grid.position.set(center.x, box.min.y, center.z);
  }
  controls.update();
}

function setModel(object: THREE.Object3D) {
  disposeModel();
  currentModel = object;
  scene.add(object);
  setWireframeState(wireframe);
  frameObject(object);
  statusEl.textContent = T.vertices.replace(
    '{n}',
    countVertices(object).toLocaleString()
  );
}

async function loadModel(path: string, base64: string) {
  const token = (loadToken += 1);
  hideError();
  statusEl.textContent = T.loading;
  fileNameEl.textContent = path.split(/[\\/]/).pop() ?? path;
  setSystemOpen(path);

  const ext = extOf(path);
  // 2D formats default to an orthographic top-down view; everything else uses
  // the existing perspective camera. The user can override with the toolbar.
  applyViewMode(userForced2D ?? is2DFormat(ext));

  const object = await parseModel(ext, base64ToBytes(base64), path);
  if (token !== loadToken) return; // a newer file superseded this one
  setModel(object);
}

// --- Event wiring ---
resetBtn.addEventListener('click', () => {
  if (currentModel) frameObject(currentModel);
});

wireframeBtn.addEventListener('click', () => {
  wireframe = !wireframe;
  setWireframeState(wireframe);
  wireframeBtn.textContent = wireframe ? T.wireframeOn : T.wireframeOff;
});

viewModeBtn.addEventListener('click', () => {
  userForced2D = !is2D;
  applyViewMode(userForced2D);
});

function openCurrentInSystemApp() {
  const target = currentPath;
  if (!target) return;
  window.whaleExt.postMessage({ type: 'openLinkExternally', url: target });
}

openSystemBtn.addEventListener('click', openCurrentInSystemApp);
openNativeBtn.addEventListener('click', openCurrentInSystemApp);

// --- Host message handling ---
window.whaleExt.onMessage((msg) => {
  switch (msg.type) {
    case 'fileContent':
      if (msg.encoding === 'base64') {
        currentPath = msg.path;
        loadModel(msg.path, msg.content).catch((e: unknown) => {
          showError(
            T.parseError.replace(
              '{msg}',
              e instanceof Error ? e.message : String(e)
            ),
            msg.path
          );
        });
      }
      break;
    case 'setTheme':
      applyTheme(msg.theme);
      break;
    case 'cadWasm': {
      const pending = pendingCadWasm.get(msg.requestId);
      if (!pending) break;
      pendingCadWasm.delete(msg.requestId);
      if (msg.data) {
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.error || 'Failed to load CAD wasm'));
      }
      break;
    }
    case 'dwgConvertedContent': {
      const pending = pendingDwgConversions.get(msg.requestId);
      if (!pending) break;
      pendingDwgConversions.delete(msg.requestId);
      if (msg.data) {
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.error || 'DWG conversion failed'));
      }
      break;
    }
    default:
      break;
  }
});

window.whaleExt.onLocale(() => applyLocale());
window.whaleExt.postMessage({ type: 'ready' });
applyTheme('light');
applyLocale();
initThree();
