/**
 * Optional AI component — install / uninstall lifecycle.
 *
 * The component ships as a `.whaleai` archive (7z) containing `manifest.json`
 * + `node_modules/` (the SDK + CLI + peerDeps). This module extracts it
 * atomically into `<userData>/components/ai/`: extract to a temp sibling,
 * validate the manifest, then rename over the live dir so a failed/partial
 * install never corrupts a working one.
 *
 * Reuses `sevenZipBinary()` from archive.ts (same bundled 7zip-bin the
 * archive viewer uses) — no second 7za probe.
 */
import fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';

import { sevenZipBinary } from '../archive';
import type { AiComponentState } from '../../shared/ai-types';
import {
  AI_COMPONENT_ID,
  getAiComponentState,
  getComponentDir,
  getComponentsRoot,
  type ComponentManifest,
} from './component-resolver';

export interface InstallResult {
  ok: boolean;
  state?: AiComponentState;
  error?: string;
}

export interface UninstallResult {
  ok: boolean;
  error?: string;
}

/** Read + lightly validate a manifest at an arbitrary path. */
function readManifestAt(manifestPath: string): ComponentManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<ComponentManifest>;
    if (!parsed || parsed.component !== AI_COMPONENT_ID || !parsed.version) {
      return null;
    }
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
 * Locate the manifest inside an extracted tree. Accepts either a flat layout
 * (`<tmp>/manifest.json`) or a single wrapping folder (`<tmp>/<name>/manifest.json`,
 * common when 7z is created from a parent directory).
 *
 * Returns the content directory (the folder holding manifest + node_modules)
 * plus the manifest, or null if no valid manifest is found.
 */
async function findContentDir(tmpDir: string): Promise<{ dir: string; manifest: ComponentManifest } | null> {
  const direct = path.join(tmpDir, 'manifest.json');
  if (fs.existsSync(direct)) {
    const m = readManifestAt(direct);
    if (m) return { dir: tmpDir, manifest: m };
  }
  try {
    const entries = await fsp.readdir(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(tmpDir, entry.name);
      const mp = path.join(sub, 'manifest.json');
      if (fs.existsSync(mp)) {
        const m = readManifestAt(mp);
        if (m) return { dir: sub, manifest: m };
      }
    }
  } catch {
    // ignore — fall through to "not found"
  }
  return null;
}

/**
 * Install (or replace) the AI component from a `.whaleai` (7z) package path.
 * Atomic swap with rollback on failure; the previous install is preserved if
 * anything goes wrong mid-swap.
 */
export async function installAiComponent(packageFilePath: string): Promise<InstallResult> {
  if (!packageFilePath) return { ok: false, error: '未选择组件包文件' };
  if (!fs.existsSync(packageFilePath)) {
    return { ok: false, error: `文件不存在:${packageFilePath}` };
  }
  const sevenZip = sevenZipBinary();
  if (!sevenZip) {
    return { ok: false, error: '未找到 7za 解压工具(7zip-bin 缺失)' };
  }

  await fsp.mkdir(getComponentsRoot(), { recursive: true });
  const tmpDir = path.join(
    getComponentsRoot(),
    `${AI_COMPONENT_ID}.tmp-${randomBytes(6).toString('hex')}`
  );

  try {
    // 1. Extract into a fresh temp dir (no output noise).
    await new Promise<void>((resolve, reject) => {
      execFile(
        sevenZip,
        ['x', packageFilePath, `-o${tmpDir}`, '-y', '-bso0', '-bsp0', '-bse0'],
        { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(typeof stderr === 'string' && stderr ? stderr : err.message));
          } else {
            resolve();
          }
        }
      );
    });

    // 2. Validate manifest + node_modules.
    const found = await findContentDir(tmpDir);
    if (!found) {
      return { ok: false, error: '组件包无效:缺少 manifest.json 或 component 字段不匹配' };
    }
    if (!fs.existsSync(path.join(found.dir, 'node_modules'))) {
      return { ok: false, error: '组件包无效:缺少 node_modules' };
    }

    // 3. Atomic swap: rename old aside, move new in; roll back on failure.
    const target = getComponentDir(AI_COMPONENT_ID);
    const backup = `${target}.old-${randomBytes(4).toString('hex')}`;
    try {
      if (fs.existsSync(target)) {
        await fsp.rename(target, backup);
      }
      if (path.resolve(found.dir) === path.resolve(tmpDir)) {
        await fsp.rename(tmpDir, target);
      } else {
        // Content sits in a subfolder of tmpDir — promote it.
        await fsp.rename(found.dir, target);
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      if (!fs.existsSync(target) && fs.existsSync(backup)) {
        await fsp.rename(backup, target).catch(() => undefined);
      }
      throw e;
    }
    // Swap succeeded — drop the backup of the old version.
    if (fs.existsSync(backup)) {
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }

    return { ok: true, state: getAiComponentState() };
  } catch (e) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove the AI component entirely.
 *
 * Windows cannot `unlink` a running `claude.exe` — a direct recursive `rm`
 * throws EPERM whenever a Claude CLI subprocess is alive (warm query, in-flight
 * turn) or a scanner holds the file. But Windows CAN rename a directory that
 * contains a locked `.exe`. So we rename the component dir aside first (the
 * app then sees it as uninstalled — `getComponentDir` no longer exists), then
 * best-effort delete the renamed dir plus any stale `.uninstalling-*` / `.old-*`
 * dirs left by earlier uninstalls/upgrades. A dir that still can't be deleted
 * lingers out of the way and is retried on the next uninstall and at startup
 * (see {@link cleanupStaleComponentDirs}). */
export async function uninstallAiComponent(): Promise<UninstallResult> {
  const dir = getComponentDir(AI_COMPONENT_ID);
  const root = getComponentsRoot();
  try {
    if (fs.existsSync(dir)) {
      const aside = path.join(
        root,
        `${AI_COMPONENT_ID}.uninstalling-${randomBytes(4).toString('hex')}`
      );
      try {
        await fsp.rename(dir, aside);
      } catch {
        // Rename itself failed (very rare) — fall back to a direct rm so the
        // caller still surfaces the real underlying error.
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }
    // Sweep stale aside/backup dirs from this and prior attempts (claude.exe
    // may still be locked → those rm calls just no-op; they'll succeed once
    // the CLI subprocess is gone).
    await cleanupStaleComponentDirs(root).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Best-effort remove of `<components>/ai.uninstalling-*` and `ai.old-*` dirs
 * left behind by {@link uninstallAiComponent} (and by the installer's
 * atomic-swap backup in {@link installAiComponent}) when `claude.exe` was
 * locked at the time. Safe to call anytime; still-locked dirs are skipped
 * (caught) and retried on a later call. Called on every uninstall and at
 * startup so a one-off uninstall doesn't leak ~150 MB forever.
 */
export async function cleanupStaleComponentDirs(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter(
        (name) =>
          name.startsWith(`${AI_COMPONENT_ID}.uninstalling-`) ||
          name.startsWith(`${AI_COMPONENT_ID}.old-`)
      )
      .map((name) =>
        fsp
          .rm(path.join(root, name), { recursive: true, force: true })
          .catch(() => undefined)
      )
  );
}
