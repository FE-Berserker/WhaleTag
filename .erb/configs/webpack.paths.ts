import path from 'path';

/**
 * All paths are resolved relative to this file (.erb/configs/),
 * so `..` -> `.erb`, `../..` -> project root.
 */
const root = path.resolve(__dirname, '..', '..');

export const ROOT_PATH = root;
export const SRC_PATH = path.resolve(root, 'src');
export const DIST_PATH = path.resolve(root, 'release', 'app', 'dist');

/** Main-process + preload output (electron-main target). */
export const MAIN_DIST = path.resolve(DIST_PATH, 'main');
/** Renderer output (loaded via file:// in production). */
export const RENDERER_DIST = path.resolve(DIST_PATH, 'renderer');

/** Renderer source root (also holds index.html template). */
export const RENDERER_SRC = path.resolve(SRC_PATH, 'renderer');

/** Extension source root and output. */
export const EXTENSIONS_SRC = path.resolve(SRC_PATH, 'extensions');
export const EXTENSIONS_DIST = path.resolve(DIST_PATH, 'extensions');

/** Dev-only DLL build cache (reserved for future HMR optimization). */
export const DLL_PATH = path.resolve(root, '.erb', 'dll');

/** Dev renderer server port — must match the URL loaded in main.ts. */
export const DEV_SERVER_PORT = 4002;
