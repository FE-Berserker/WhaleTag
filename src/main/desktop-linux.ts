/**
 * Linux desktop-environment fallbacks (docs/16 C-2).
 *
 * WhaleTag is developed on Windows, but three gestures have no portable API
 * and used to assume a specific desktop:
 *
 *  - "run command" opened an `xterm` window; GNOME / KDE / Cinnamon do NOT
 *    ship xterm, and the spawn failure was swallowed, so the menu item did
 *    nothing at all;
 *  - "reveal in folder" fell back to `nautilus --select` only; Dolphin and
 *    other file managers exist too, and the modern portable way to select a
 *    file is the `org.freedesktop.FileManager1` D-Bus interface;
 *  - `zip` is NOT installed by default on several distributions (Ubuntu
 *    Desktop included), so packaging a selection failed even though `python3`
 *    — which ships everywhere — can write the same archive.
 *
 * Everything here is a pure plan (an ordered list of commands) plus one
 * sequential launcher, so the desktop-specific knowledge is unit-testable on
 * every OS; the callers own the actual spawn/exec and error surfacing.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';

/** One command in an ordered fallback chain. */
export interface DesktopCommand {
  bin: string;
  args: string[];
}

/** A terminal candidate; the command line differs per terminal. */
export interface TerminalCandidate {
  bin: string;
  /** Builds the argv that runs `command` in a login shell inside the terminal. */
  argsFor: (command: string) => string[];
}

const bashLc = (command: string): string[] => ['bash', '-lc', command];

/**
 * Ordered terminal candidates for Linux. `$TERMINAL` wins (the user's own
 * choice), then Debian's alternatives symlink, then the common DE terminals;
 * `xterm` stays last as the traditional fallback.
 *
 * Only terminals that accept a PROGRAM + ARGS argv are listed. Terminals that
 * take one pre-joined string (`-e "bash -c ..."`) are deliberately omitted:
 * joining here would re-introduce a shell-quoting layer that
 * `shell-quote.ts` already handled once.
 */
export function linuxTerminalCandidates(
  env: NodeJS.ProcessEnv = process.env
): TerminalCandidate[] {
  const candidates: TerminalCandidate[] = [];
  const userTerminal = env.TERMINAL?.trim();
  if (userTerminal) {
    candidates.push({ bin: userTerminal, argsFor: (c) => ['-e', ...bashLc(c)] });
  }
  candidates.push(
    { bin: 'x-terminal-emulator', argsFor: (c) => ['-e', ...bashLc(c)] },
    // gnome-terminal deprecated `-e`; `--` passes the program verbatim.
    { bin: 'gnome-terminal', argsFor: (c) => ['--', ...bashLc(c)] },
    { bin: 'konsole', argsFor: (c) => ['-e', ...bashLc(c)] },
    { bin: 'xfce4-terminal', argsFor: (c) => ['-x', ...bashLc(c)] },
    { bin: 'tilix', argsFor: (c) => ['-e', ...bashLc(c)] },
    // kitty runs the given program directly, without a `-e` switch.
    { bin: 'kitty', argsFor: (c) => bashLc(c) },
    { bin: 'alacritty', argsFor: (c) => ['-e', ...bashLc(c)] },
    { bin: 'xterm', argsFor: (c) => ['-e', ...bashLc(c)] }
  );
  return candidates;
}

/**
 * Minimal child-process surface the launcher needs — lets tests inject a
 * fake spawn without mocking the `child_process` module.
 */
export interface SpawnedChild {
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export type SpawnLike = (bin: string, args: string[]) => SpawnedChild;

function defaultSpawn(bin: string, args: string[]): SpawnedChild {
  return spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
  }) as unknown as SpawnedChild;
}

/**
 * Try every terminal candidate in order until one actually spawns. Returns
 * the binary that started; throws when none does (the renderer surfaces that
 * instead of the old silent no-op). `spawn` fires asynchronously for a missing
 * binary (ENOENT), so this waits for the `spawn` event rather than treating a
 * returned ChildProcess as success.
 */
export async function launchLinuxTerminal(
  command: string,
  candidates: TerminalCandidate[] = linuxTerminalCandidates(),
  spawnImpl: SpawnLike = defaultSpawn
): Promise<string> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const child = spawnImpl(candidate.bin, candidate.argsFor(command));
      await new Promise<void>((resolve, reject) => {
        child.on('spawn', () => resolve());
        child.on('error', (error) => reject(error));
      });
      child.unref();
      return candidate.bin;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.bin}: ${message}`);
    }
  }
  throw new Error(
    `No terminal emulator could be launched (tried ${failures.join('; ')})`
  );
}

/**
 * Ordered "reveal and select" steps for Linux. The D-Bus `FileManager1`
 * interface asks whichever file manager is running to select the item
 * (Nautilus, Dolphin, Nemo, Caja implement it); the CLI calls cover managers
 * that do not, and `xdg-open` last only opens the containing folder — it is
 * still better than a hard failure.
 */
export function linuxRevealSteps(targetPath: string): DesktopCommand[] {
  const uri = pathToFileURL(targetPath).href;
  return [
    {
      bin: 'dbus-send',
      args: [
        '--session',
        '--dest=org.freedesktop.FileManager1',
        '--type=method_call',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItems',
        `array:string:${uri}`,
        'string:',
      ],
    },
    { bin: 'nautilus', args: ['--select', targetPath] },
    { bin: 'dolphin', args: ['--select', targetPath] },
    { bin: 'xdg-open', args: [path.dirname(targetPath)] },
  ];
}

/**
 * `[source, archiveName]` pairs for the python3 zip fallback. `archiveName` is
 * relative to `cwd` (the deepest common parent), matching what `zip -r` from
 * that directory would store. Directories are walked by the python script.
 */
export function pythonZipPairs(
  sources: string[],
  cwd: string
): Array<[string, string]> {
  return sources.map((source) => [
    path.resolve(source),
    path.relative(cwd, source),
  ]);
}

/**
 * python3 script for `pythonZipPairs`: writes the archive with the same
 * relative layout as `zip -r` (dirs are walked; empty dirs are skipped, which
 * is the one documented difference).
 */
export const PYTHON_ZIP_SCRIPT = `import json, os, sys, zipfile

pairs = json.loads(sys.argv[1])
archive = sys.argv[2]
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
    for source, entry in pairs:
        if os.path.isdir(source):
            for root, _dirs, files in os.walk(source):
                for name in files:
                    full = os.path.join(root, name)
                    rel = os.path.relpath(full, source)
                    zf.write(full, os.path.join(entry, rel))
        else:
            zf.write(source, entry)
`;
