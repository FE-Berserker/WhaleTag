import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Auto-update state machine tests (docs/18). `electron` and `electron-updater`
 * are stubbed before the module is imported: the real updater needs a packaged
 * app, a code signature and network access, none of which exist under
 * `node:test`. What is worth testing here is our own glue — dev-mode
 * short-circuits, check/download de-duplication, error translation to the
 * `AppUpdateCheckResult` union, event fan-out, and the quit guard.
 */

const APP_DIR = path.join(
  os.tmpdir(),
  `whaletag-auto-update-${process.pid}-${Date.now()}`
);
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(
  path.join(APP_DIR, 'package.json'),
  JSON.stringify({ name: 'whaletag', version: '0.5.0' })
);

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  feed: unknown = null;
  checkCalls = 0;
  downloadCalls = 0;
  checkImpl: () => Promise<unknown> = async () => null;
  downloadImpl: () => Promise<void> = async () => undefined;
  installImpl: () => void = () => undefined;

  setFeedURL(url: unknown): void {
    this.feed = url;
  }
  checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    return this.checkImpl();
  }
  downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
    return this.downloadImpl();
  }
  quitAndInstall(): void {
    this.installImpl();
  }
}

const fakeUpdater = new FakeUpdater();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronStub: any = {
  app: {
    isPackaged: true,
    getAppPath: () => APP_DIR,
    getPath: () => APP_DIR,
    getVersion: () => '0.5.0',
    setName: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-updater') return { autoUpdater: fakeUpdater };
  return originalLoad.apply(Module, [request, ...rest]);
};

type AutoUpdateModule = typeof import('./auto-update');
let mod: AutoUpdateModule;

before(async () => {
  mod = await import('./auto-update');
  mod.initAutoUpdater();
});

function remoteInfo(version: string, notes?: unknown) {
  return {
    version,
    releaseDate: '2026-01-01T00:00:00.000Z',
    releaseNotes: notes,
  };
}

describe('auto-update — wiring', () => {
  it('points at the GitHub channel and disables silent download/install', () => {
    assert.deepEqual(fakeUpdater.feed, {
      provider: 'github',
      owner: 'FE-Berserker',
      repo: 'WhaleTag',
    });
    assert.equal(fakeUpdater.autoDownload, false);
    assert.equal(fakeUpdater.autoInstallOnAppQuit, false);
  });

  it('is idempotent (init twice keeps a single wiring)', () => {
    const feedBefore = fakeUpdater.feed;
    mod.initAutoUpdater();
    assert.deepEqual(fakeUpdater.feed, feedBefore);
  });
});

describe('auto-update — checking', () => {
  it('reports update-available with normalized release notes', async () => {
    fakeUpdater.checkImpl = async () => ({
      updateInfo: remoteInfo('0.6.0', 'plain notes'),
    });
    const result = await mod.checkForUpdates();
    assert.equal(result.kind, 'update-available');
    if (result.kind === 'update-available') {
      assert.equal(result.info.version, '0.6.0');
      assert.equal(result.info.releaseNotes, 'plain notes');
    }
  });

  it('flattens the array form of releaseNotes', async () => {
    fakeUpdater.checkImpl = async () => ({
      updateInfo: remoteInfo('0.6.1', [{ note: 'first item' }, { note: 'second' }]),
    });
    const result = await mod.checkForUpdates();
    assert.equal(result.kind, 'update-available');
    if (result.kind === 'update-available') {
      assert.equal(result.info.releaseNotes, 'first item');
    }
  });

  it('reports no-update when the remote version equals the running one', async () => {
    fakeUpdater.checkImpl = async () => ({ updateInfo: remoteInfo('0.5.0') });
    const result = await mod.checkForUpdates();
    assert.deepEqual(result, { kind: 'no-update', current: '0.5.0' });
  });

  it('reports no-update when the updater resolves null', async () => {
    fakeUpdater.checkImpl = async () => null;
    const result = await mod.checkForUpdates();
    assert.equal(result.kind, 'no-update');
  });

  it('translates a thrown check into { kind: error }', async () => {
    fakeUpdater.checkImpl = async () => {
      throw new Error('network down');
    };
    const result = await mod.checkForUpdates();
    assert.deepEqual(result, { kind: 'error', error: 'network down' });
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    let resolveProbe: (value: unknown) => void = () => undefined;
    const probe = new Promise<unknown>((resolve) => {
      resolveProbe = resolve;
    });
    fakeUpdater.checkCalls = 0;
    fakeUpdater.checkImpl = () => probe;
    const a = mod.checkForUpdates();
    const b = mod.checkForUpdates();
    resolveProbe({ updateInfo: remoteInfo('0.7.0') });
    const [resultA, resultB] = await Promise.all([a, b]);
    assert.equal(fakeUpdater.checkCalls, 1);
    assert.equal(resultA.kind, 'update-available');
    assert.equal(resultB.kind, 'update-available');
  });

  it('allows a new probe after the previous one settled', async () => {
    fakeUpdater.checkCalls = 0;
    fakeUpdater.checkImpl = async () => null;
    await mod.checkForUpdates();
    await mod.checkForUpdates();
    assert.equal(fakeUpdater.checkCalls, 2);
  });
});

describe('auto-update — downloading', () => {
  it('shares one in-flight download between concurrent callers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeUpdater.downloadCalls = 0;
    fakeUpdater.downloadImpl = () => gate;
    const a = mod.downloadUpdate();
    const b = mod.downloadUpdate();
    release();
    const [resultA, resultB] = await Promise.all([a, b]);
    assert.equal(fakeUpdater.downloadCalls, 1);
    assert.equal(resultA.kind, 'downloading');
    assert.equal(resultB.kind, 'downloading');
  });

  it('translates a thrown download into { kind: error }', async () => {
    fakeUpdater.downloadImpl = async () => {
      throw new Error('disk full');
    };
    const result = await mod.downloadUpdate();
    assert.deepEqual(result, { kind: 'error', error: 'disk full' });
  });
});

describe('auto-update — event fan-out', () => {
  it('delivers availability to every subscriber, isolating a thrower', () => {
    const seen: string[] = [];
    const offThrower = mod.subscribe('available', () => {
      throw new Error('subscriber bug');
    });
    const offCounter = mod.subscribe('available', (info) => {
      if ('version' in info) seen.push(info.version);
    });
    try {
      fakeUpdater.emit('update-available', remoteInfo('0.8.0'));
      assert.deepEqual(seen, ['0.8.0']);
    } finally {
      offThrower();
      offCounter();
    }
  });

  it('forwards download progress and errors', () => {
    const progress: number[] = [];
    const errors: string[] = [];
    const offProgress = mod.subscribe('progress', (p) => {
      if ('percent' in p) progress.push(p.percent);
    });
    const offError = mod.subscribe('error', (message) => {
      if (typeof message === 'string') errors.push(message);
    });
    try {
      fakeUpdater.emit('download-progress', {
        percent: 42,
        bytesPerSecond: 1,
        transferred: 2,
        total: 100,
      });
      fakeUpdater.emit('error', new Error('boom'));
      assert.deepEqual(progress, [42]);
      assert.deepEqual(errors, ['boom']);
    } finally {
      offProgress();
      offError();
    }
  });
});

describe('auto-update — quit + dev mode', () => {
  it('quits and installs when packaged', () => {
    let installed = 0;
    fakeUpdater.installImpl = () => {
      installed += 1;
    };
    mod.quitAndInstall();
    assert.equal(installed, 1);
  });

  it('swallows a synchronous quitAndInstall throw instead of crashing main', () => {
    fakeUpdater.installImpl = () => {
      throw new Error('no update downloaded');
    };
    assert.doesNotThrow(() => mod.quitAndInstall());
  });

  it('short-circuits every operation in a dev build', async () => {
    electronStub.app.isPackaged = false;
    fakeUpdater.checkCalls = 0;
    fakeUpdater.downloadCalls = 0;
    let installed = 0;
    fakeUpdater.installImpl = () => {
      installed += 1;
    };
    try {
      assert.deepEqual(await mod.checkForUpdates(), { kind: 'unsupported' });
      assert.deepEqual(await mod.downloadUpdate(), {
        kind: 'error',
        error: 'unsupported',
      });
      mod.quitAndInstall();
      assert.equal(fakeUpdater.checkCalls, 0);
      assert.equal(fakeUpdater.downloadCalls, 0);
      assert.equal(installed, 0);
    } finally {
      electronStub.app.isPackaged = true;
    }
  });

  it('schedules no startup probe in a dev build', async () => {
    electronStub.app.isPackaged = false;
    fakeUpdater.checkCalls = 0;
    try {
      mod.scheduleStartupCheck(5, true);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(fakeUpdater.checkCalls, 0);
    } finally {
      electronStub.app.isPackaged = true;
    }
  });

  it('runs the delayed startup probe once when packaged + enabled', async () => {
    fakeUpdater.checkCalls = 0;
    fakeUpdater.checkImpl = async () => null;
    mod.scheduleStartupCheck(5, true);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(fakeUpdater.checkCalls, 1);
    // Disabled flag skips it entirely.
    fakeUpdater.checkCalls = 0;
    mod.scheduleStartupCheck(5, false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(fakeUpdater.checkCalls, 0);
  });
});
