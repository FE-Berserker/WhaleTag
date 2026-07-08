/**
 * Environment + binary discovery for the Claude Code CLI — a focused port of
 * Claudian's `src/utils/env.ts`, trimmed to what Whale needs (the Obsidian
 * device-settings-key machinery and context-limit helpers are dropped).
 *
 * GUI Electron apps can launch with a minimal PATH, so {@link getEnhancedPath}
 * prepends common Node/npm/CLI install locations before spawning the CLI.
 * Pure Node; main process only.
 */
import * as fs from 'fs';
import * as path from 'path';

import { parsePathEntries, resolveNvmDefaultBin } from './path';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';
const NODE_EXECUTABLE = isWindows ? 'node.exe' : 'node';

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/**
 * Common binary locations for the platform. Phase A covers the high-frequency
 * install paths (Claude native installer, npm global, Node.js installer,
 * Homebrew, nvm). The full volta/asdf/fnm/scoop/chocolatey enumeration from
 * Claudian is intentionally deferred — PATH-based discovery (`where claude`)
 * already covers those when they are on the user's PATH, which the Whale main
 * process inherits.
 */
function getExtraBinaryPaths(): string[] {
  const home = getHomeDir();
  if (isWindows) {
    const paths: string[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 =
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    if (appData) paths.push(path.join(appData, 'npm'));
    if (localAppData) {
      paths.push(path.join(localAppData, 'Programs', 'nodejs'));
      paths.push(path.join(localAppData, 'Programs', 'node'));
    }
    paths.push(path.join(programFiles, 'nodejs'));
    paths.push(path.join(programFilesX86, 'nodejs'));
    const nvmSymlink = process.env.NVM_SYMLINK;
    if (nvmSymlink) paths.push(nvmSymlink);
    const nvmHome = process.env.NVM_HOME;
    if (nvmHome) paths.push(nvmHome);
    else if (appData) paths.push(path.join(appData, 'nvm'));
    const voltaHome = process.env.VOLTA_HOME;
    if (voltaHome) paths.push(path.join(voltaHome, 'bin'));
    else if (home) paths.push(path.join(home, '.volta', 'bin'));
    if (home) {
      paths.push(path.join(home, '.local', 'bin'));
      paths.push(path.join(home, '.bun', 'bin'));
    }
    return paths.filter(Boolean);
  }
  const paths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  if (home) {
    paths.push(path.join(home, '.local', 'bin'));
    paths.push(path.join(home, '.bun', 'bin'));
    const nvmBin = process.env.NVM_BIN;
    if (nvmBin) paths.push(nvmBin);
    else {
      const nvmDefault = resolveNvmDefaultBin(home);
      if (nvmDefault) paths.push(nvmDefault);
    }
  }
  return paths;
}

export function findNodeDirectory(additionalPaths?: string): string | null {
  const searchPaths = getExtraBinaryPaths();
  const pathDirs = parsePathEntries(process.env.PATH || '');
  const additionalDirs = additionalPaths ? parsePathEntries(additionalPaths) : [];
  const allPaths = [...additionalDirs, ...searchPaths, ...pathDirs];
  for (const dir of allPaths) {
    if (!dir) continue;
    try {
      const nodePath = path.join(dir, NODE_EXECUTABLE);
      if (fs.existsSync(nodePath)) {
        const stat = fs.statSync(nodePath);
        if (stat.isFile()) return dir;
      }
    } catch {
      // inaccessible directory
    }
  }
  return null;
}

export function findNodeExecutable(additionalPaths?: string): string | null {
  const nodeDir = findNodeDirectory(additionalPaths);
  return nodeDir ? path.join(nodeDir, NODE_EXECUTABLE) : null;
}

/** True if the CLI path is a JS file or a script whose shebang invokes node. */
export function cliPathRequiresNode(cliPath: string): boolean {
  const jsExtensions = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
  const lower = cliPath.toLowerCase();
  if (jsExtensions.some((ext) => lower.endsWith(ext))) return true;
  try {
    if (!fs.existsSync(cliPath)) return false;
    const stat = fs.statSync(cliPath);
    if (!stat.isFile()) return false;
    let fd: number | null = null;
    try {
      fd = fs.openSync(cliPath, 'r');
      // Uint8Array (not Buffer) avoids the TS 5.9 + @types/node 20
      // SharedArrayBuffer-vs-ArrayBuffer mismatch on fs.readSync's buffer arg.
      const buffer = new Uint8Array(200);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = Buffer.from(buffer.subarray(0, bytesRead)).toString('utf8');
      if (!header.startsWith('#!')) return false;
      const shebangLine = header.split(/\r?\n/)[0].toLowerCase();
      return shebangLine.includes('node');
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return false;
  }
}

/**
 * Build a PATH that prepends common binary locations + the CLI's own directory
 * (and Node's directory when the CLI needs Node) to the inherited PATH. Lets
 * the CLI find `node` and bundled tools even when Electron launched with a
 * minimal PATH.
 */
export function getEnhancedPath(additionalPaths?: string, cliPath?: string): string {
  const extraPaths = getExtraBinaryPaths().filter(Boolean);
  const currentPath = process.env.PATH || '';
  const segments: string[] = [];
  if (additionalPaths) segments.push(...parsePathEntries(additionalPaths));
  let cliDirHasNode = false;
  if (cliPath) {
    try {
      const cliDir = path.dirname(cliPath);
      const nodeInCliDir = path.join(cliDir, NODE_EXECUTABLE);
      if (fs.existsSync(nodeInCliDir)) {
        const stat = fs.statSync(nodeInCliDir);
        if (stat.isFile()) {
          segments.push(cliDir);
          cliDirHasNode = true;
        }
      }
    } catch {
      // ignore
    }
  }
  if (cliPath && cliPathRequiresNode(cliPath) && !cliDirHasNode) {
    const nodeDir = findNodeDirectory();
    if (nodeDir) segments.push(nodeDir);
  }
  segments.push(...extraPaths);
  if (currentPath) segments.push(...parsePathEntries(currentPath));
  const seen = new Set<string>();
  const unique = segments.filter((p) => {
    const normalized = isWindows ? p.toLowerCase() : p;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return unique.join(PATH_SEPARATOR);
}

/** Parse a multiline `KEY=value` block into a record. `#` lines are skipped. */
export function parseEnvironmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ')
      ? trimmed.slice(7)
      : trimmed;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex > 0) {
      const key = normalized.substring(0, eqIndex).trim();
      let value = normalized.substring(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) result[key] = value;
    }
  }
  return result;
}
