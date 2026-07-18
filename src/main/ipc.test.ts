/**
 * Regression test for `shell:revealAndSelect` — the right-click "Reveal in
 * File Explorer" handler. Pre-fix this was silently broken on Windows:
 *   - The implementation used `child_process.execFile('explorer.exe',
 *     ['/select,<path>'])` which mis-parses paths containing spaces,
 *     commas, or non-ASCII on Win10/11.
 *   - The `run` helper always resolved (never rejected), so spawn failures
 *     vanished into a console.warn with no UI feedback.
 *
 * These tests pin down the contract so a future refactor can't reintroduce
 * either bug:
 *   - Windows: `shell.showItemInFolder(path)` is the only FS touch.
 *   - macOS:   `execFile('open', ['-R', path])`.
 *   - Linux:   `execFile('xdg-open', [parent])` then
 *              `execFile('nautilus', ['--select', path])`; the first is
 *              best-effort (`tolerateNonZeroExit`) and the second must
 *              surface failures.
 *   - Spawn errors reject (not resolve) so the renderer can show an error
 *     instead of closing the menu with no feedback.
 *
 * Mocking strategy: Electron 42's bundled `node:test` predates
 * `t.mock.module` (probed — `t.mock` and `mock.*` are empty). We work
 * around this by populating `require.cache` with stub entries for
 * `electron` and `child_process` before the dynamic `import('./ipc')`.
 * `ipc.ts` is compiled to CommonJS by ts-node, so `require('electron')`
 * picks up the stub. The original cached entries (if any) are restored in
 * afterEach so other test files aren't poisoned.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { setAllowedRoots } from './allowed-roots';

// tsconfig.json has `module: CommonJS`, so `import.meta.url` is not
// available. `__filename` is the CommonJS equivalent — the test file
// runs through ts-node/register, which sets it.
const require_ = createRequire(__filename);

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

/** Outcome for the next (or current call index) `execFile` invocation. */
type ExecOutcome = 'success' | 'exit-error' | 'spawn-error';

interface TestRig {
  ipcHandlers: Map<string, Handler>;
  showItemInFolderCalls: { args: unknown[] }[];
  execFileCalls: { args: unknown[] }[];
  /** Per-call outcome. Index aligns with the call sequence. */
  outcomes: ExecOutcome[];
  registerIpcHandlers: () => void;
}

const SAVED_CACHE = new Map<string, NodeJS.Module | undefined>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  if (!SAVED_CACHE.has(modulePath)) {
    SAVED_CACHE.set(modulePath, require_.cache[modulePath]);
  }
  const existing = require_.cache[modulePath];
  // Reuse the original children / paths so dependents keep working.
  const stub: NodeJS.Module = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: existing?.children ?? [],
    paths: existing?.paths ?? [],
  } as NodeJS.Module;
  require_.cache[modulePath] = stub;
}

function clearInjectedMocks(): void {
  for (const [modulePath, original] of SAVED_CACHE.entries()) {
    if (original) {
      require_.cache[modulePath] = original;
    } else {
      delete require_.cache[modulePath];
    }
  }
  SAVED_CACHE.clear();
}

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

async function buildRig(): Promise<TestRig> {
  const ipcHandlers = new Map<string, Handler>();
  const showItemInFolderCalls: { args: unknown[] }[] = [];
  const execFileCalls: { args: unknown[] }[] = [];
  const outcomes: ExecOutcome[] = [];

  // Inject `electron` stub. `ipc.ts` uses named imports, which the
  // CommonJS interop layer resolves from the default export. Setting the
  // same object on both keeps every import style happy.
  const electronStub = {
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        ipcHandlers.set(channel, handler);
      },
      // `drag:startFile` (line ~1103) uses `ipcMain.on`; we don't need to
      // assert anything about it, just don't crash.
      on: () => undefined,
    },
    shell: {
      showItemInFolder: (...args: unknown[]) => {
        showItemInFolderCalls.push({ args });
      },
      // `openNative` resolves '' on success (Electron returns an error string
      // only on failure).
      openPath: async () => '',
    },
    dialog: { showOpenDialog: () => undefined },
    clipboard: { writeText: () => undefined },
    nativeImage: {
      createFromPath: () => null,
      createFromBuffer: () => null,
    },
    BrowserWindow: class {},
  };
  injectMock('electron', electronStub);

  // Inject `child_process` stub. The real handler calls
  // `execFile(cmd, args, opts, callback)`, so the stub matches.
  const childProcessStub = {
    exec: () => undefined,
    execFile: (
      cmd: unknown,
      args: unknown,
      _opts: unknown,
      cb: (err: { code?: number; message: string } | null) => void
    ) => {
      execFileCalls.push({ args: [cmd, args] });
      const child = new EventEmitter();
      const outcome = outcomes[execFileCalls.length - 1] ?? 'success';
      setImmediate(() => {
        if (outcome === 'spawn-error') {
          child.emit('error', new Error('spawn ENOENT'));
          return;
        }
        if (outcome === 'exit-error') {
          cb({ code: 1, message: 'exited 1' });
          return;
        }
        cb(null);
      });
      return child;
    },
  };
  injectMock('child_process', childProcessStub);

  // Now require the module under test. `require_` is from
  // `createRequire(__filename)` so the resolution is relative to this
  // test file. `require.cache` is the mechanism that lets the stubs
  // above intercept `require('electron')` / `require('child_process')`
  // from inside `ipc.ts`. (Await `import()` would try to resolve as
  // ESM, which doesn't auto-resolve `.ts` under ts-node.)
  // Drop any cached ipc.ts from a prior test in this run so the next
  // `require_('./ipc')` re-evaluates the module against the freshly
  // injected `electron` / `child_process` stubs.
  const ipcPath = require_.resolve('./ipc');
  delete require_.cache[ipcPath];
  const mod = require_('./ipc');
  return {
    ipcHandlers,
    showItemInFolderCalls,
    execFileCalls,
    outcomes,
    registerIpcHandlers: mod.registerIpcHandlers,
  };
}

describe('shell:revealAndSelect handler', () => {
  const originalPlatform = process.platform;
  let rig: TestRig;

  beforeEach(async () => {
    // Each test gets a fresh dynamic import; the previous test's module
    // record is invalidated by clearing the require.cache below.
    clearInjectedMocks();
    rig = await buildRig();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    clearInjectedMocks();
    // Also wipe the ipc module itself from the cache so the next test
    // re-runs its top-level imports against fresh stubs.
    const ipcPath = require_.resolve('./ipc');
    delete require_.cache[ipcPath];
  });

  it('Windows: routes through shell.showItemInFolder (no execFile)', async () => {
    setPlatform('win32');
    rig.registerIpcHandlers();

    const handler = rig.ipcHandlers.get('shell:revealAndSelect');
    assert.ok(handler, 'shell:revealAndSelect handler should be registered');
    await handler!({}, 'C:\\Users\\foo\\file with space.txt');

    assert.equal(
      rig.showItemInFolderCalls.length,
      1,
      'shell.showItemInFolder must be called once on Windows'
    );
    assert.equal(
      rig.showItemInFolderCalls[0].args[0],
      'C:\\Users\\foo\\file with space.txt',
      'showItemInFolder should receive the full path verbatim'
    );
    assert.equal(
      rig.execFileCalls.length,
      0,
      'execFile must not be called on Windows (regression: pre-fix used explorer.exe /select,<path>)'
    );
  });

  it('macOS: spawns `open -R <path>`', async () => {
    setPlatform('darwin');
    rig.registerIpcHandlers();

    const handler = rig.ipcHandlers.get('shell:revealAndSelect')!;
    await handler({}, '/Users/foo/bar.md');

    assert.equal(rig.execFileCalls.length, 1);
    const [cmd, args] = rig.execFileCalls[0].args as [string, string[]];
    assert.equal(cmd, 'open');
    assert.deepEqual(args, ['-R', '/Users/foo/bar.md']);
  });

  it('macOS: spawn errors reject (not silently resolve)', async () => {
    setPlatform('darwin');
    rig.registerIpcHandlers();
    rig.outcomes.push('spawn-error');

    const handler = rig.ipcHandlers.get('shell:revealAndSelect')!;
    await assert.rejects(
      async () => {
        await handler({}, '/Users/foo/bar.md');
      },
      /spawn ENOENT/,
      'spawn failures must reject so the renderer can show an error'
    );
  });

  it('Linux: tries xdg-open first then nautilus --select', async () => {
    setPlatform('linux');
    rig.registerIpcHandlers();

    const handler = rig.ipcHandlers.get('shell:revealAndSelect')!;
    await handler({}, '/home/foo/bar.md');

    assert.equal(
      rig.execFileCalls.length,
      2,
      'both xdg-open and nautilus must run on Linux'
    );
    const first = rig.execFileCalls[0].args as [string, string[]];
    const second = rig.execFileCalls[1].args as [string, string[]];
    assert.equal(first[0], 'xdg-open');
    assert.deepEqual(first[1], ['/home/foo']);
    assert.equal(second[0], 'nautilus');
    assert.deepEqual(second[1], ['--select', '/home/foo/bar.md']);
  });

  it('Linux: xdg-open non-zero exit does not abort the chain', async () => {
    setPlatform('linux');
    rig.registerIpcHandlers();
    rig.outcomes.push('exit-error'); // xdg-open exits non-zero
    rig.outcomes.push('success'); // nautilus succeeds

    const handler = rig.ipcHandlers.get('shell:revealAndSelect')!;
    await handler({}, '/home/foo/bar.md');
    assert.equal(
      rig.execFileCalls.length,
      2,
      'nautilus must still run after xdg-open fails (tolerateNonZeroExit)'
    );
  });

  it('Linux: xdg-open spawn failure falls back to nautilus (does not throw)', async () => {
    setPlatform('linux');
    rig.registerIpcHandlers();
    rig.outcomes.push('spawn-error'); // xdg-open missing
    rig.outcomes.push('success'); // nautilus succeeds

    const handler = rig.ipcHandlers.get('shell:revealAndSelect')!;
    await handler({}, '/home/foo/bar.md');
    assert.equal(
      rig.execFileCalls.length,
      2,
      'nautilus fallback must run after xdg-open spawn failure'
    );
  });

  it('Linux: nautilus --select spawn failure rejects so the user sees an error', async () => {
    setPlatform('linux');
    rig.registerIpcHandlers();
    rig.outcomes.push('success'); // xdg-open ok
    rig.outcomes.push('spawn-error'); // nautilus missing

    const handler = rig.ipcHandlers.get('shell:revealAndSelect')!;
    await assert.rejects(
      async () => {
        await handler({}, '/home/foo/bar.md');
      },
      /spawn ENOENT/,
      'nautilus is the terminal step; its failure must reject'
    );
  });
});

/**
 * Read-side confinement (docs/13 §13): `fs:readFile` / `fs:readTextFile` /
 * `fs:openNative` must refuse paths outside the configured locations —
 * previously they were bare `fsp.readFile` / `shell.openPath`, so an
 * extension iframe (`requestFileBytes` / `openLinkExternally`) could read or
 * OS-launch anything on disk. The guard is the same
 * `assertWithinAllowedRoot` the write channels use, so it fails CLOSED when
 * no roots are registered.
 */
describe('read-side allowedRoots guards', () => {
  let rig: TestRig;
  let root: string;

  beforeEach(async () => {
    clearInjectedMocks();
    rig = await buildRig();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-read-guard-'));
    setAllowedRoots([root]);
    rig.registerIpcHandlers();
  });

  afterEach(async () => {
    setAllowedRoots([]);
    clearInjectedMocks();
    const ipcPath = require_.resolve('./ipc');
    delete require_.cache[ipcPath];
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('fs:readFile reads a file inside an allowed root', async () => {
    const inside = path.join(root, 'a.txt');
    await fsp.writeFile(inside, 'hello');
    const handler = rig.ipcHandlers.get('fs:readFile')!;
    const buf = (await handler({}, inside)) as Buffer;
    assert.equal(buf.toString('utf8'), 'hello');
  });

  it('fs:readFile refuses a path outside every allowed root', async () => {
    const handler = rig.ipcHandlers.get('fs:readFile')!;
    await assert.rejects(
      async () => handler({}, path.join(os.tmpdir(), 'whale-outside.bin')),
      /Refused/
    );
  });

  it('fs:readTextFile reads inside, refuses outside', async () => {
    const inside = path.join(root, 'note.txt');
    await fsp.writeFile(inside, 'hello whale', 'utf8');
    const handler = rig.ipcHandlers.get('fs:readTextFile')!;
    assert.equal(await handler({}, inside), 'hello whale');
    await assert.rejects(
      async () => handler({}, path.join(os.tmpdir(), 'outside.txt')),
      /Refused/
    );
  });

  it('fs:openNative opens inside, refuses outside', async () => {
    const inside = path.join(root, 'a.txt');
    await fsp.writeFile(inside, 'x');
    const handler = rig.ipcHandlers.get('fs:openNative')!;
    await handler({}, inside); // resolves — stubbed shell.openPath returns ''
    await assert.rejects(
      async () => handler({}, 'C:\\Windows\\System32\\cmd.exe'),
      /Refused/
    );
  });

  it('read guards fail closed when no roots are registered', async () => {
    setAllowedRoots([]);
    const handler = rig.ipcHandlers.get('fs:readFile')!;
    await assert.rejects(
      async () => handler({}, path.join(root, 'a.txt')),
      /Refused/
    );
  });
});
