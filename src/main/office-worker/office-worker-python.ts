/**
 * Discover a Python interpreter that can `import uno` (`pythonuno`).
 *
 * Mirrors `sofficeBinary()` (../thumbnail.ts) in shape: explicit candidates →
 * derive from the resolved soffice `program/` dir → system `python3` fallback
 * → memoised + inflight-deduped, with a `python -c "import uno"` probe.
 *
 * Why the bundled-python path matters: LibreOffice ships `pythonuno` compiled
 * against ITS bundled python, so that python is the most reliable client for
 * driving a UNO listener. The system `python3` works only when the distro
 * package (`python3-uno` on Debian/Ubuntu, `libreoffice-script-provider-python`)
 * is installed — hence the fallback.
 *
 * Why `cwd` is load-bearing on Windows: `import uno` from LO's bundled
 * `python.exe` only succeeds when the process cwd is the LO `program/` dir
 * (DLL search path for `pyuno.pyd`). So every probe AND the eventual host
 * spawn both set `cwd = path.dirname(pythonPath)`.
 *
 * Negative results are cached too: `resetOfficePythonCache()` clears the
 * memos so the host can force a fresh probe after marking the worker
 * unavailable (the host's own cooldown gates HOW OFTEN that happens).
 */

import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';

export interface ResolvedPython {
  /** Absolute path to the python binary (or a bare PATH name for system python). */
  python: string;
  /** cwd the host MUST pass to spawn() — LO program/ dir on Windows. */
  cwd: string;
}

// Top-level memo for the whole resolution (assumes sofficePath is stable
// across a session — it comes from sofficeBinary, which is itself memoised).
// `undefined` = not yet probed; `null` = probed and none found.
let _resolved: ResolvedPython | null | undefined;
let _resolveInflight: Promise<ResolvedPython | null> | null;

// Per-binary probe memos (a binary can be probed once even across multiple
// resolution attempts; cleared only by resetOfficePythonCache).
const _probeMemo = new Map<string, boolean>();
const _probeInflight = new Map<string, Promise<boolean>>();

/**
 * Returns true when `pythonPath` can `import uno`. Inflight-deduped so the
 * concurrent first-callers of `resolveOfficePython` share one spawn.
 */
function probePythonUno(pythonPath: string): Promise<boolean> {
  const cached = _probeMemo.get(pythonPath);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = _probeInflight.get(pythonPath);
  if (existing) return existing;

  const p = new Promise<boolean>((resolve) => {
    execFile(
      pythonPath,
      ['-c', 'import uno'],
      {
        timeout: 4000,
        // CRITICAL on Windows: bundled python needs cwd = LO program/ for
        // the pyuno.pyd DLL search. Harmless elsewhere.
        cwd: path.dirname(pythonPath),
        windowsHide: true,
      },
      (err) => {
        _probeInflight.delete(pythonPath);
        const ok = !err;
        _probeMemo.set(pythonPath, ok);
        resolve(ok);
      }
    );
  });
  _probeInflight.set(pythonPath, p);
  return p;
}

/** The primary bundled-python path next to a resolved soffice binary. */
function primaryPythonCandidates(sofficePath: string): string[] {
  const dir = path.dirname(sofficePath);
  if (process.platform === 'win32') {
    return [path.join(dir, 'python.exe')];
  }
  return [path.join(dir, 'python')];
}

/**
 * Some LO releases put the real interpreter under
 * `program/python-core-X.X.X/bin/python(.exe)` with `python.exe` as a thin
 * wrapper. Probe these dynamically via readdir when the primary candidate
 * doesn't pan out.
 */
async function pythonCoreCandidates(sofficePath: string): Promise<string[]> {
  const dir = path.dirname(sofficePath);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  const out: string[] = [];
  for (const e of entries) {
    if (e.startsWith('python-core-')) {
      const p = path.join(dir, e, 'bin', exe);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** Last-resort: a system python3/python on PATH with `python3-uno` installed. */
async function systemPython3WithUno(): Promise<string | null> {
  const names =
    process.platform === 'win32'
      ? ['python', 'python3']
      : ['python3', 'python'];
  for (const n of names) {
    const ok = await probePythonUno(n).catch(() => false);
    if (ok) return n;
  }
  return null;
}

/**
 * Resolve the python to use for the worker.
 *
 * @param sofficePath a resolved soffice binary path (from `sofficeBinary`),
 *   or null when LibreOffice itself wasn't found — in which case we still try
 *   system python3+uno (rare: LO missing but python3-uno present).
 * @returns `{python, cwd}` or null when no usable interpreter exists.
 */
export async function resolveOfficePython(
  sofficePath: string | null
): Promise<ResolvedPython | null> {
  if (_resolved !== undefined) return _resolved;
  if (_resolveInflight) return _resolveInflight;

  _resolveInflight = (async () => {
    try {
      let result: ResolvedPython | null = null;

      if (sofficePath) {
        const candidates = [
          ...primaryPythonCandidates(sofficePath),
          ...(await pythonCoreCandidates(sofficePath)),
        ];
        for (const c of candidates) {
          if (!existsSync(c)) continue;
          if (await probePythonUno(c)) {
            result = { python: c, cwd: path.dirname(c) };
            break;
          }
        }
      }

      if (!result) {
        const sys = await systemPython3WithUno();
        if (sys) result = { python: sys, cwd: path.dirname(sys) };
      }

      _resolved = result;
      return result;
    } finally {
      _resolveInflight = null;
    }
  })();
  return _resolveInflight;
}

/** Clear all memos so the next `resolveOfficePython` re-probes from scratch. */
export function resetOfficePythonCache(): void {
  _resolved = undefined;
  _probeMemo.clear();
  // Inflight probes resolve themselves and will repopulate nothing harmful.
}
