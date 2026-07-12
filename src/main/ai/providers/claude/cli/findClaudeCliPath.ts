/**
 * Discover the Claude Code CLI binary — verbatim port of Claudian's
 * `src/providers/claude/cli/findClaudeCLIPath.ts` (only the import path moved).
 * Pure Node `fs`/`os`/`path`; runs in the Electron main process.
 *
 * Resolution order (Windows prefers native `.exe` then Node-backed package
 * entrypoints, deliberately avoiding `.cmd` shims because they require
 * `shell:true` and break SDK stdio streaming):
 *  1. An explicit PATH override from settings.
 *  2. Native install locations (`~/.claude/local/claude(.exe)`, AppData,
 *     Program Files, Homebrew, nvm default bin, …).
 *  3. npm-global `@anthropic-ai/claude-code` package entrypoints
 *     (`cli-wrapper.cjs` / `cli.js`).
 *  4. The inherited `$PATH` (`where`/`which`-style enumeration).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parsePathEntries, resolveNvmDefaultBin } from '../../../utils/path';

const CLAUDE_CODE_PACKAGE_SEGMENTS = [
  'node_modules',
  '@anthropic-ai',
  'claude-code',
];
const CLAUDE_CODE_NODE_ENTRYPOINTS = ['cli-wrapper.cjs', 'cli.js'];

function getEnvValue(name: string): string | undefined {
  return process.env[name];
}

function dedupePaths(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findFirstExistingPath(
  entries: string[],
  candidates: string[]
): string | null {
  for (const dir of entries) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (isExistingFile(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

/**
 * File-exists checker — a module-level seam so tests can make discovery
 * deterministic without monkeypatching the `fs` namespace (whose bindings are
 * non-configurable under `import * as fs`). Production code uses the default
 * real-`fs` checker; {@link __setFileCheckerForTest} swaps it for a mock.
 */
type FileChecker = (filePath: string) => boolean;
const realFileChecker: FileChecker = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      return stat.isFile();
    }
  } catch {
    // Inaccessible path
  }
  return false;
};
let fileChecker: FileChecker = realFileChecker;

/** Test-only seam: override the file-exists check. Returns a restore fn. */
export function __setFileCheckerForTest(checker: FileChecker): () => void {
  const prev = fileChecker;
  fileChecker = checker;
  return () => {
    fileChecker = prev;
  };
}

function isExistingFile(filePath: string): boolean {
  return fileChecker(filePath);
}

function findClaudeCodeNodeEntrypoint(packageRoot: string): string | null {
  for (const entrypoint of CLAUDE_CODE_NODE_ENTRYPOINTS) {
    const candidate = path.join(packageRoot, entrypoint);
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveClaudeCodeEntrypointNearPathEntry(
  entry: string,
  isWindows: boolean
): string | null {
  const directCandidate = findClaudeCodeNodeEntrypoint(
    path.join(entry, ...CLAUDE_CODE_PACKAGE_SEGMENTS)
  );
  if (directCandidate) {
    return directCandidate;
  }
  const baseName = path.basename(entry).toLowerCase();
  if (baseName === 'bin') {
    const prefix = path.dirname(entry);
    const packageParent = isWindows ? prefix : path.join(prefix, 'lib');
    const candidate = findClaudeCodeNodeEntrypoint(
      path.join(packageParent, ...CLAUDE_CODE_PACKAGE_SEGMENTS)
    );
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function resolveClaudeCodeEntrypointFromPathEntries(
  entries: string[],
  isWindows: boolean
): string | null {
  for (const entry of entries) {
    const candidate = resolveClaudeCodeEntrypointNearPathEntry(entry, isWindows);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function resolveClaudeFromPathEntries(
  entries: string[],
  isWindows: boolean
): string | null {
  if (entries.length === 0) {
    return null;
  }
  if (!isWindows) {
    return findFirstExistingPath(entries, ['claude']);
  }
  const exeCandidate = findFirstExistingPath(entries, ['claude.exe', 'claude']);
  if (exeCandidate) {
    return exeCandidate;
  }
  const packageEntrypoint = resolveClaudeCodeEntrypointFromPathEntries(
    entries,
    isWindows
  );
  if (packageEntrypoint) {
    return packageEntrypoint;
  }
  return null;
}

function getNpmGlobalPrefix(): string | null {
  if (process.env.npm_config_prefix) {
    return process.env.npm_config_prefix;
  }
  if (process.platform === 'win32') {
    const appDataNpm = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : null;
    if (appDataNpm && fs.existsSync(appDataNpm)) {
      return appDataNpm;
    }
  }
  return null;
}

function addClaudeCodeEntrypointPaths(
  paths: string[],
  packageParent: string
): void {
  const packageRoot = path.join(packageParent, ...CLAUDE_CODE_PACKAGE_SEGMENTS);
  for (const entrypoint of CLAUDE_CODE_NODE_ENTRYPOINTS) {
    paths.push(path.join(packageRoot, entrypoint));
  }
}

function getNpmClaudeCodeEntrypointPaths(): string[] {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const entrypointPaths: string[] = [];
  if (isWindows) {
    addClaudeCodeEntrypointPaths(
      entrypointPaths,
      path.join(homeDir, 'AppData', 'Roaming', 'npm')
    );
    const npmPrefix = getNpmGlobalPrefix();
    if (npmPrefix) {
      addClaudeCodeEntrypointPaths(entrypointPaths, npmPrefix);
    }
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 =
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    addClaudeCodeEntrypointPaths(
      entrypointPaths,
      path.join(programFiles, 'nodejs', 'node_global')
    );
    addClaudeCodeEntrypointPaths(
      entrypointPaths,
      path.join(programFilesX86, 'nodejs', 'node_global')
    );
    addClaudeCodeEntrypointPaths(
      entrypointPaths,
      path.join('D:', 'Program Files', 'nodejs', 'node_global')
    );
  } else {
    addClaudeCodeEntrypointPaths(
      entrypointPaths,
      path.join(homeDir, '.npm-global', 'lib')
    );
    addClaudeCodeEntrypointPaths(entrypointPaths, '/usr/local/lib');
    addClaudeCodeEntrypointPaths(entrypointPaths, '/usr/lib');
    if (process.env.npm_config_prefix) {
      addClaudeCodeEntrypointPaths(
        entrypointPaths,
        path.join(process.env.npm_config_prefix, 'lib')
      );
    }
  }
  return entrypointPaths;
}

/**
 * Dev-mode only: resolve the CLI entrypoint from the `@anthropic-ai/claude-code`
 * devDependency in node_modules. Returns `null` in a packaged build — the dep
 * is no longer shipped with the installer (0.2.0), so the runtime CLI comes
 * from the optional AI component (see {@link componentCliPath}). `eval` hides
 * the call from webpack's static analysis (the package is never bundled).
 */
function bundledCliPath(): string | null {
  try {
    const resolve = eval('require.resolve') as (id: string) => string;
    const pkgJsonPath = resolve('@anthropic-ai/claude-code/package.json');
    const pkgDir = path.dirname(pkgJsonPath);
    for (const entrypoint of CLAUDE_CODE_NODE_ENTRYPOINTS) {
      const candidate = path.join(pkgDir, entrypoint);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Package not present / not resolvable — fall through to discovery.
  }
  return null;
}

/**
 * Test-only override for the AI component root (the dir containing
 * `@anthropic-ai/claude-code`). Production resolves it from Electron's
 * `userData`; tests inject a fixture path so the resolution is deterministic
 * without an Electron runtime. Mirrors the {@link __setFileCheckerForTest} seam.
 */
let componentRootOverride: string | null = null;
export function __setComponentRootForTest(root: string | null): () => void {
  const prev = componentRootOverride;
  componentRootOverride = root;
  return () => {
    componentRootOverride = prev;
  };
}

/**
 * Resolve the CLI from the OPTIONAL AI component (user-installed `.whaleai`
 * extracted to `<userData>/components/ai/node_modules/@anthropic-ai/claude-code`).
 * Returns `null` when the component isn't installed.
 *
 * `require('electron')` is lazy + guarded: this module also runs under
 * `node:test` (no Electron runtime), where the require returns the electron
 * executable path string instead of the module — `app` is then undefined and
 * we bail with null (or the test-injected override is used instead).
 */
function componentCliPath(): string | null {
  let componentRoot: string;
  if (componentRootOverride) {
    componentRoot = componentRootOverride;
  } else {
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const electron = require('electron');
      const userData = (
        electron as { app?: { getPath: (name: string) => string } }
      ).app?.getPath('userData');
      if (!userData) return null;
      componentRoot = path.join(
        userData,
        'components',
        'ai',
        'node_modules',
        '@anthropic-ai',
        'claude-code'
      );
    } catch {
      return null;
    }
  }

  if (!isExistingFile(path.join(componentRoot, 'package.json'))) return null;

  // v2.x ships a prebuilt single-executable: bin/claude.exe (win) / bin/claude.
  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const exe = path.join(componentRoot, 'bin', exeName);
  if (isExistingFile(exe)) return exe;

  // Fallback to legacy node entrypoints if the package ships those instead.
  return findClaudeCodeNodeEntrypoint(componentRoot);
}

/**
 * Resolve the Claude Code CLI path. `pathValue` (optional) is an explicit
 * settings override searched first. Returns `null` when nothing is found —
 * callers surface a friendly "install Claude Code" message.
 */
export function findClaudeCLIPath(pathValue?: string): string | null {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';

  const customEntries = dedupePaths(parsePathEntries(pathValue));
  if (customEntries.length > 0) {
    const customResolution = resolveClaudeFromPathEntries(customEntries, isWindows);
    if (customResolution) {
      return customResolution;
    }
  }

  // Dev mode: the @anthropic-ai/claude-code devDependency in node_modules
  // (resolved at runtime via Node's require; `eval` hides it from webpack
  // static analysis since the package is an external, not bundled). Returns
  // null in a packaged build — the dep is no longer shipped with the installer.
  const bundled = bundledCliPath();
  if (bundled) {
    return bundled;
  }

  // Optional AI component: the user-installed `.whaleai` extracted to
  // <userData>/components/ai/. Takes priority over any system-installed claude
  // so the version WhaleTag shipped via the component is the one used.
  const component = componentCliPath();
  if (component) {
    return component;
  }

  if (isWindows) {
    const exePaths: string[] = [
      path.join(homeDir, '.claude', 'local', 'claude.exe'),
      path.join(homeDir, 'AppData', 'Local', 'Claude', 'claude.exe'),
      path.join(
        process.env.ProgramFiles || 'C:\\Program Files',
        'Claude',
        'claude.exe'
      ),
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Claude',
        'claude.exe'
      ),
      path.join(homeDir, '.local', 'bin', 'claude.exe'),
    ];
    for (const p of exePaths) {
      if (isExistingFile(p)) {
        return p;
      }
    }
    const packageEntrypointPaths = getNpmClaudeCodeEntrypointPaths();
    for (const p of packageEntrypointPaths) {
      if (isExistingFile(p)) {
        return p;
      }
    }
  }

  const commonPaths: string[] = [
    path.join(homeDir, '.claude', 'local', 'claude'),
    path.join(homeDir, '.local', 'bin', 'claude'),
    path.join(homeDir, '.volta', 'bin', 'claude'),
    path.join(homeDir, '.asdf', 'shims', 'claude'),
    path.join(homeDir, '.asdf', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(homeDir, 'bin', 'claude'),
    path.join(homeDir, '.npm-global', 'bin', 'claude'),
  ];

  const npmPrefix = getNpmGlobalPrefix();
  if (npmPrefix) {
    commonPaths.push(path.join(npmPrefix, 'bin', 'claude'));
  }

  // NVM: resolve default version bin when NVM_BIN env var is unavailable (GUI apps).
  const nvmBin = resolveNvmDefaultBin(homeDir);
  if (nvmBin) {
    commonPaths.push(path.join(nvmBin, 'claude'));
  }

  for (const p of commonPaths) {
    if (isExistingFile(p)) {
      return p;
    }
  }

  if (!isWindows) {
    const packageEntrypointPaths = getNpmClaudeCodeEntrypointPaths();
    for (const p of packageEntrypointPaths) {
      if (isExistingFile(p)) {
        return p;
      }
    }
  }

  const envEntries = dedupePaths(parsePathEntries(getEnvValue('PATH')));
  if (envEntries.length > 0) {
    const envResolution = resolveClaudeFromPathEntries(envEntries, isWindows);
    if (envResolution) {
      return envResolution;
    }
  }

  return null;
}
