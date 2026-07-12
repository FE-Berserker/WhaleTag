/**
 * Optional AI component — resolver + runtime SDK loader.
 *
 * The Claude Code CLI (`@anthropic-ai/claude-code`, a ~229MB prebuilt binary)
 * and the Agent SDK (`@anthropic-ai/claude-agent-sdk`) are NOT shipped in the
 * main installer. They live in a user-installed component package under
 * `<userData>/components/ai/`. This module is the single source of truth for:
 *
 *  - where the component lives (path helpers),
 *  - whether it is installed (manifest read),
 *  - how to load the SDK at runtime (dev node_modules → component node_modules).
 *
 * Lives in its own file with no SDK value import so it is safe to load at
 * startup (the main bundle never requires `@anthropic-ai/*` at module-eval
 * time — only inside `loadClaudeSdk`, which is called lazily by the runtime
 * IPC handlers, and only when the component is present).
 */
import { app } from 'electron';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

import type { AiComponentState } from '../../shared/ai-types';

export const AI_COMPONENT_ID = 'ai';

/** Root dir holding all optional components: `<userData>/components`. */
export function getComponentsRoot(): string {
  return path.join(app.getPath('userData'), 'components');
}

/** Dir for a specific component: `<userData>/components/<id>`. */
export function getComponentDir(id: string = AI_COMPONENT_ID): string {
  return path.join(getComponentsRoot(), id);
}

export interface ComponentManifest {
  component: string;
  version: string;
  claudeCodeVersion?: string;
  sdkVersion?: string;
  createdAt?: string;
}

const MANIFEST_NAME = 'manifest.json';

/**
 * Read a component's manifest. Returns `null` when the component is not
 * installed or the manifest is malformed/unversioned. Kept tolerant: a bad
 * manifest degrades to "not installed" rather than throwing.
 */
export function readComponentManifest(
  id: string = AI_COMPONENT_ID
): ComponentManifest | null {
  try {
    const manifestPath = path.join(getComponentDir(id), MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) return null;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ComponentManifest>;
    if (!parsed || parsed.component !== id || !parsed.version) return null;
    return {
      component: parsed.component,
      version: parsed.version,
      claudeCodeVersion: parsed.claudeCodeVersion,
      sdkVersion: parsed.sdkVersion,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Dev-only: the SDK is a devDependency, so in `npm run dev` it sits in
 * node_modules and is usable WITHOUT the component package. Mirror that here so
 * the renderer gating + runtime registration treat AI as available during
 * development. The packaged build has no devDeps, so this returns false there.
 *
 * `eval('require')` hides the call from webpack (the SDK is an external); same
 * trick as {@link loadClaudeSdk}.
 */
function isDevSdkAvailable(): boolean {
  if (app.isPackaged) return false;
  try {
    const nativeRequire = eval('require') as NodeRequire;
    nativeRequire('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/** Snapshot of the AI component for the renderer (status badge + gating). */
export function getAiComponentState(): AiComponentState {
  const manifest = readComponentManifest(AI_COMPONENT_ID);
  if (manifest) {
    return {
      installed: true,
      version: manifest.version,
      claudeCodeVersion: manifest.claudeCodeVersion,
      sdkVersion: manifest.sdkVersion,
      path: getComponentDir(AI_COMPONENT_ID),
    };
  }
  if (isDevSdkAvailable()) {
    return { installed: true, version: 'dev', path: '(dev node_modules)' };
  }
  return { installed: false };
}

export function isAiComponentInstalled(): boolean {
  return readComponentManifest(AI_COMPONENT_ID) !== null || isDevSdkAvailable();
}

/**
 * `<componentDir>/node_modules` — where the component's SDK + CLI + peerDeps
 * live. Returns `null` if the component dir exists but has no node_modules
 * (half-installed / corrupt) so callers can refuse to load.
 */
export function getComponentSdkDir(
  id: string = AI_COMPONENT_ID
): string | null {
  const dir = path.join(getComponentDir(id), 'node_modules');
  return fs.existsSync(dir) ? dir : null;
}

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkCache: ClaudeSdk | null = null;

/** Test-only: clear the cached SDK instance (after install/uninstall). */
export function __clearSdkCacheForTest(): void {
  sdkCache = null;
}

/**
 * Resolve + load the Claude Agent SDK at runtime. Resolution order:
 *
 *  1. **Dev / bundled node_modules** — the SDK is a devDependency, so in `npm
 *     run dev` it sits in the project's node_modules and a plain `require`
 *     finds it. In a packaged build the dep is absent and this throws
 *     `MODULE_NOT_FOUND` (caught below).
 *  2. **AI component** — `<userData>/components/ai/node_modules`, loaded via
 *     `createRequire` scoped to that dir so the SDK's peerDeps (zod,
 *     `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`) resolve there too.
 *
 * `eval('require')` hides the call from webpack's static analysis (mirrors
 * `findClaudeCliPath.ts`'s `eval('require.resolve')` trick); the package is
 * also listed in webpack externals, so it is never bundled regardless. The
 * result is cached for the process lifetime.
 *
 * Throws if neither path resolves — runtime IPC handlers must catch and
 * surface a "component not installed" error to the renderer.
 */
export async function loadClaudeSdk(): Promise<ClaudeSdk> {
  if (sdkCache) return sdkCache;

  // 1) Bundled / dev node_modules.
  try {
    const nativeRequire = eval('require') as NodeRequire;
    sdkCache = nativeRequire('@anthropic-ai/claude-agent-sdk');
    return sdkCache;
  } catch {
    // Not in node_modules (packaged build without the dep) — try the component.
  }

  // 2) AI component node_modules.
  const sdkDir = getComponentSdkDir(AI_COMPONENT_ID);
  if (sdkDir) {
    try {
      // createResolve anchor inside the component's node_modules so resolution
      // starts there; the SDK and its peerDeps all live under this dir.
      const componentRequire = createRequire(
        path.join(sdkDir, '__component_self__.js')
      );
      sdkCache = componentRequire('@anthropic-ai/claude-agent-sdk');
      return sdkCache;
    } catch {
      // Component dir present but SDK unloadable (corrupt / partial install).
    }
  }

  throw new Error(
    'Claude Agent SDK 不可用:未安装 AI 组件。请在 设置 → AI 中安装 AI 组件包。'
  );
}
