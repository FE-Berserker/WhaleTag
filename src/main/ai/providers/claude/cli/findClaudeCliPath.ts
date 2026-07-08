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
 * Resolve the CLI entrypoint from the BUNDLED `@anthropic-ai/claude-code`
 * package (shipped inside the installer). Returns `null` when the package
 * isn't installed/resolvable (e.g. dev without the dep, or the require fails).
 */
function bundledCliPath(): string | null {
  try {
    // `eval` hides this from webpack's static analysis — the package is an
    // external that's asarUnpack'd at runtime, so Node's require.resolve
    // finds it from the bundled node_modules, not the webpack graph.
    const resolve = eval('require.resolve') as (id: string) => string;
    let pkgJsonPath = resolve('@anthropic-ai/claude-code/package.json');
    // require.resolve returns the LOGICAL asar path (.../app.asar/.../package.json),
    // but @anthropic-ai/claude-code is asarUnpack'd, so the file physically lives
    // under app.asar.unpacked. customSpawn runs the CLI with an EXTERNAL node —
    // which can't read inside the .asar archive (it's a single packed file, not a
    // directory). Remap to the real unpacked path so node can actually load it.
    if (pkgJsonPath.includes('app.asar')) {
      pkgJsonPath = pkgJsonPath.replace(
        /([\\/])app\.asar([\\/])/,
        '$1app.asar.unpacked$2'
      );
    }
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

  // The BUNDLED @anthropic-ai/claude-code package (shipped inside the Whale
  // installer, asarUnpack'd). Resolved at RUNTIME via Node's require so users
  // don't need to install Claude Code separately. `eval` hides this from
  // webpack's static analysis (the package is external + unpacked, not bundled).
  const bundled = bundledCliPath();
  if (bundled) {
    return bundled;
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
