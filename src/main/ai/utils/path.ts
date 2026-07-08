/**
 * Filesystem path helpers for the AI runtime — a focused port of Claudian's
 * `src/utils/path.ts`, with the Obsidian `getVaultPath` helper dropped (Whale
 * has no Obsidian App object). Pure Node; safe in the Electron main process.
 *
 * Used by the CLI discovery (`findClaudeCliPath`) and the environment/PATH
 * enhancement (`env.ts`), and `isPathWithinDirectory` backs the read-only
 * location guard.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function getEnvValue(key: string): string | undefined {
  const hasKey = (name: string): boolean =>
    name in process.env && process.env[name] !== undefined;
  if (hasKey(key)) return process.env[key];
  if (process.platform !== 'win32') return undefined;
  const upper = key.toUpperCase();
  if (hasKey(upper)) return process.env[upper];
  const lower = key.toLowerCase();
  if (hasKey(lower)) return process.env[lower];
  const matchKey = Object.keys(process.env).find(
    (name) => name.toLowerCase() === key.toLowerCase()
  );
  return matchKey ? process.env[matchKey] : undefined;
}

function expandEnvironmentVariables(value: string): string {
  if (!value.includes('%') && !value.includes('$') && !value.includes('!')) {
    return value;
  }
  const isWindows = process.platform === 'win32';
  let expanded = value;
  expanded = expanded.replace(
    /%([A-Za-z_][A-Za-z0-9_]*(?:\([A-Za-z0-9_]+\))?[A-Za-z0-9_]*)%/g,
    (match, name) => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    }
  );
  if (isWindows) {
    expanded = expanded.replace(/!([A-Za-z_][A-Za-z0-9_]*)!/g, (match, name) => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });
    expanded = expanded.replace(
      /\$env:([A-Za-z_][A-Za-z0-9_]*)/gi,
      (match, name) => {
        const envValue = getEnvValue(name);
        return envValue !== undefined ? envValue : match;
      }
    );
  }
  expanded = expanded.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, name1, name2) => {
      const key = name1 ?? name2;
      if (!key) return match;
      const envValue = getEnvValue(key);
      return envValue !== undefined ? envValue : match;
    }
  );
  return expanded;
}

export function expandHomePath(p: string): string {
  const expanded = expandEnvironmentVariables(p);
  if (expanded === '~') return os.homedir();
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  return expanded;
}

/** Translate MSYS/Git Bash paths (`/c/Users/...`) to Windows (`C:\Users\...`). */
export function translateMsysPath(value: string): string {
  if (process.platform !== 'win32') return value;
  const msysMatch = value.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msysMatch) {
    const driveLetter = msysMatch[1].toUpperCase();
    const restOfPath = msysMatch[2] ?? '';
    return `${driveLetter}:${restOfPath.replace(/\//g, '\\')}`;
  }
  return value;
}

function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Split a PATH-style string into individual directory entries. */
export function parsePathEntries(pathValue?: string): string[] {
  if (!pathValue) return [];
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return pathValue
    .split(delimiter)
    .map((segment) => stripSurroundingQuotes(segment.trim()))
    .filter((segment) => {
      if (!segment) return false;
      const upper = segment.toUpperCase();
      return upper !== '$PATH' && upper !== '${PATH}' && upper !== '%PATH%';
    })
    .map((segment) => translateMsysPath(expandHomePath(segment)));
}

const NVM_LATEST_INSTALLED_ALIASES = new Set(['node', 'stable']);

function isNvmBuiltInLatestAlias(alias: string): boolean {
  return NVM_LATEST_INSTALLED_ALIASES.has(alias);
}

function findMatchingNvmVersion(
  entries: string[],
  resolvedAlias: string
): string | undefined {
  if (isNvmBuiltInLatestAlias(resolvedAlias)) return entries[0];
  const version = resolvedAlias.replace(/^v/, '');
  return entries.find((entry) => {
    const entryVersion = entry.slice(1);
    return entryVersion === version || entryVersion.startsWith(version + '.');
  });
}

function resolveNvmAlias(
  nvmDir: string,
  alias: string,
  depth = 0
): string | null {
  if (depth > 5) return null;
  if (/^\d/.test(alias) || alias.startsWith('v')) return alias;
  if (isNvmBuiltInLatestAlias(alias)) return alias;
  try {
    const aliasFile = path.join(nvmDir, 'alias', ...alias.split('/'));
    const target = fs.readFileSync(aliasFile, 'utf8').trim();
    if (!target) return null;
    return resolveNvmAlias(nvmDir, target, depth + 1);
  } catch {
    return null;
  }
}

/** GUI apps don't have NVM_BIN set; resolve nvm's default alias from disk. */
export function resolveNvmDefaultBin(home: string): string | null {
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  try {
    const alias = fs
      .readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8')
      .trim();
    if (!alias) return null;
    const resolved = resolveNvmAlias(nvmDir, alias);
    if (!resolved) return null;
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    const entries = fs
      .readdirSync(versionsDir)
      .filter((entry) => entry.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const matched = findMatchingNvmVersion(entries, resolved);
    if (matched) {
      const binDir = path.join(versionsDir, matched, 'bin');
      if (fs.existsSync(binDir)) return binDir;
    }
  } catch {
    // nvm not installed
  }
  return null;
}

/** Best-effort realpath that resolves the nearest existing ancestor. */
function resolveRealPath(p: string): string {
  const realpathFn = (fs.realpathSync.native ??
    fs.realpathSync) as (src: fs.PathLike) => string;
  try {
    return realpathFn(p);
  } catch {
    const absolute = path.resolve(p);
    let current = absolute;
    const suffix: string[] = [];
    for (;;) {
      try {
        if (fs.existsSync(current)) {
          const resolvedExisting = realpathFn(current);
          return suffix.length > 0
            ? path.join(resolvedExisting, ...suffix.reverse())
            : resolvedExisting;
        }
      } catch {
        // keep walking up
      }
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function normalizePathForComparison(value: string): string {
  if (!value || typeof value !== 'string') return '';
  const expanded = translateMsysPath(expandHomePath(value));
  const normalized = (() => {
    try {
      return process.platform === 'win32'
        ? path.win32.normalize(expanded)
        : path.normalize(expanded);
    } catch {
      return expanded;
    }
  })();
  const withPrefix = normalized.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? withPrefix.toLowerCase() : withPrefix;
}

/**
 * True if `candidatePath` is `directoryPath` or a descendant of it. Resolves
 * symlinks on the directory side and compares case-insensitively on Windows.
 * Used by the read-only-location guard for AI tool calls.
 */
export function isPathWithinDirectory(
  candidatePath: string,
  directoryPath: string
): boolean {
  if (!candidatePath || !directoryPath) return false;
  const directoryReal = normalizePathForComparison(
    resolveRealPath(directoryPath)
  );
  const resolvedCandidate = normalizePathForComparison(
    resolveRealPath(candidatePath)
  );
  return (
    resolvedCandidate === directoryReal ||
    resolvedCandidate.startsWith(directoryReal + '/')
  );
}
