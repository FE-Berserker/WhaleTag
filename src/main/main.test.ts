import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import type { WebContents } from 'electron';

const require_ = createRequire(__filename);

/** Load main.ts without starting Electron or any of its long-lived services. */
function loadMain(
  options: { singleInstanceLock?: boolean; onQuit?: () => void } = {}
): typeof import('./main') {
  const saved = new Map<string, NodeJS.Module | undefined>();
  const moduleNames = [
    'electron',
    'electron-window-state',
    './ipc',
    './index-worker-host',
    './dir-watcher',
    './thumb-worker-host',
    './mcp/mcp-server',
    './auto-update',
    './menu',
    './allowed-roots',
    './known-roots',
    './app-version',
    './log',
    '../shared/whale-file-url',
    './protocol-range',
    './extension-protocol',
    './crash-guard',
  ];
  const neverReady = new Promise<void>(() => {});
  const electron = {
    app: {
      setPath() {},
      setName() {},
      whenReady: () => neverReady,
      on() {},
      once() {},
      requestSingleInstanceLock: () => {
        // main.ts quits on its own when this returns false; recording the quit
        // lets one test assert the second instance never bootstraps.
        const granted = options.singleInstanceLock !== false;
        return granted;
      },
      quit: () => {
        options.onQuit?.();
      },
      exit() {},
    },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { handle() {}, on() {} },
    Menu: {},
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: { defaultSession: {} },
    shell: {},
  };

  try {
    for (const name of moduleNames) {
      const filename = require_.resolve(name);
      saved.set(filename, require_.cache[filename]);
      const existing = require_.cache[filename];
      require_.cache[filename] = {
        id: filename,
        filename,
        loaded: true,
        exports: name === 'electron' ? electron : {},
        children: existing?.children ?? [],
        paths: existing?.paths ?? [],
      } as NodeJS.Module;
    }

    const unhandledRejectionListeners = new Set<unknown>(
      process.listeners('unhandledRejection')
    );
    const uncaughtExceptionListeners = new Set<unknown>(
      process.listeners('uncaughtException')
    );
    const streamListeners = [process.stdout, process.stderr].map(
      (stream) => new Set(stream.listeners('error'))
    );
    const mainPath = require_.resolve('./main');
    delete require_.cache[mainPath];
    try {
      return require_('./main') as typeof import('./main');
    } finally {
      for (const listener of process.listeners('unhandledRejection')) {
        if (!unhandledRejectionListeners.has(listener)) {
          process.removeListener('unhandledRejection', listener);
        }
      }
      for (const listener of process.listeners('uncaughtException')) {
        if (!uncaughtExceptionListeners.has(listener)) {
          process.removeListener('uncaughtException', listener);
        }
      }
      [process.stdout, process.stderr].forEach((stream, index) => {
        for (const listener of stream.listeners('error')) {
          if (!streamListeners[index].has(listener)) {
            stream.removeListener('error', listener as (error: Error) => void);
          }
        }
      });
      delete require_.cache[mainPath];
    }
  } finally {
    for (const [filename, original] of saved) {
      if (original) require_.cache[filename] = original;
      else delete require_.cache[filename];
    }
  }
}

const { createApplicationPermissionHandlers } = loadMain();
type Handlers = ReturnType<typeof createApplicationPermissionHandlers>;
type Details = Parameters<Handlers['request']>[3];

const PRODUCTION_APP_URL = pathToFileURL(
  path.resolve(__dirname, '..', 'renderer', 'index.html')
).href;
const DEVELOPMENT_APP_URL = 'http://localhost:4002/';

function fakeWebContents(url: string): WebContents {
  const fake = {
    destroyed: false,
    getURL() {
      return url;
    },
    isDestroyed() {
      return fake.destroyed;
    },
  };
  return fake as unknown as WebContents;
}

function harness(development = false, appUrl?: string): {
  handlers: Handlers;
  webContents: WebContents;
} {
  const webContents = fakeWebContents(
    appUrl ?? (development ? DEVELOPMENT_APP_URL : PRODUCTION_APP_URL)
  );
  return {
    webContents,
    handlers: createApplicationPermissionHandlers(
      () => webContents,
      development
    ),
  };
}

function request(
  handlers: Handlers,
  webContents: WebContents,
  permission: string,
  details: Details
): boolean {
  let calls = 0;
  let granted: boolean | undefined;
  handlers.request(
    webContents,
    permission,
    (value) => {
      calls += 1;
      granted = value;
    },
    details
  );
  assert.equal(calls, 1, 'request callback is resolved exactly once');
  assert.notEqual(granted, undefined);
  if (granted === undefined) assert.fail('grant callback did not run');
  return granted;
}

function check(
  handlers: Handlers,
  webContents: WebContents | null,
  permission: string,
  requestingOrigin: string,
  details: Details
): boolean {
  return handlers.check(
    webContents,
    permission,
    requestingOrigin,
    details
  );
}

function mainDetails(url = PRODUCTION_APP_URL): Details {
  return { isMainFrame: true, requestingUrl: url };
}

function extensionDetails(
  id: string,
  embeddingOrigin = 'file://',
  includeUrl = true
): Details {
  return {
    isMainFrame: false,
    requestingUrl: includeUrl
      ? `whale-extension://${id}/index.html`
      : undefined,
    embeddingOrigin,
  };
}

describe('application permissions — trusted app shell', () => {
  it('allows production clipboard writes through request and check', () => {
    const { handlers, webContents } = harness();
    assert.equal(
      request(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        mainDetails()
      ),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        'file://',
        mainDetails()
      ),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        'file://',
        { isMainFrame: true }
      ),
      true,
      'check can omit requestingUrl'
    );
  });

  it('allows only the exact development server origin', () => {
    const { handlers, webContents } = harness(true);
    const details = mainDetails(DEVELOPMENT_APP_URL);
    assert.equal(
      request(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        details
      ),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        'http://localhost:4002',
        { isMainFrame: true }
      ),
      true
    );

    for (const url of [
      'http://localhost:4002.evil.test/',
      'http://localhost:4003/',
      'https://localhost:4002/',
    ]) {
      assert.equal(
        request(
          handlers,
          webContents,
          'clipboard-sanitized-write',
          mainDetails(url)
        ),
        false,
        url
      );
    }
  });

  it('keeps unrelated permissions and app-shell fullscreen denied', () => {
    const { handlers, webContents } = harness();
    for (const permission of [
      'clipboard-read',
      'fullscreen',
      'media',
      'geolocation',
      'notifications',
      'pointerLock',
    ]) {
      assert.equal(
        request(handlers, webContents, permission, mainDetails()),
        false,
        permission
      );
      assert.equal(
        check(handlers, webContents, permission, 'file://', mainDetails()),
        false,
        permission
      );
    }
  });

  it('rejects external, arbitrary-file and opaque main-frame requests', () => {
    const { handlers, webContents } = harness();
    for (const url of [
      'https://evil.test/',
      'file:///tmp/not-whale.html',
      'about:blank',
      'whale-extension://json-viewer/index.html',
      '',
    ]) {
      assert.equal(
        request(
          handlers,
          webContents,
          'clipboard-sanitized-write',
          mainDetails(url)
        ),
        false,
        url
      );
    }
    assert.equal(
      check(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        'null',
        { isMainFrame: true }
      ),
      false
    );
  });
});

describe('application permissions — trusted extension frames', () => {
  it('allows only JSON viewer clipboard writes', () => {
    const { handlers, webContents } = harness();
    const details = extensionDetails('json-viewer');
    assert.equal(
      request(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        details
      ),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        'whale-extension://json-viewer',
        details
      ),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        'whale-extension://json-viewer',
        extensionDetails('json-viewer', 'file://', false)
      ),
      true,
      'cross-origin check without requestingUrl uses the exact origin'
    );
    assert.equal(
      request(handlers, webContents, 'fullscreen', details),
      false
    );
  });

  it('allows only image viewer fullscreen', () => {
    const { handlers, webContents } = harness();
    const details = extensionDetails('image-viewer');
    assert.equal(
      request(handlers, webContents, 'fullscreen', details),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'fullscreen',
        'whale-extension://image-viewer',
        details
      ),
      true
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'fullscreen',
        'whale-extension://image-viewer',
        extensionDetails('image-viewer', 'file://', false)
      ),
      true
    );
    assert.equal(
      request(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        details
      ),
      false
    );
  });

  it('denies lookalike origins, non-entry documents and other extensions', () => {
    const { handlers, webContents } = harness();
    for (const details of [
      {
        isMainFrame: false,
        requestingUrl: 'whale-extension://image-viewer.evil/index.html',
      },
      {
        isMainFrame: false,
        requestingUrl: 'whale-extension://image-viewer@evil.test/index.html',
      },
      { isMainFrame: false, requestingUrl: 'https://image-viewer/index.html' },
      {
        isMainFrame: false,
        requestingUrl: 'whale-extension://image-viewer/not-index.html',
      },
      extensionDetails('text-editor'),
    ]) {
      assert.equal(
        request(handlers, webContents, 'fullscreen', details),
        false,
        details.requestingUrl
      );
    }
    assert.equal(
      check(
        handlers,
        webContents,
        'fullscreen',
        'whale-extension://image-viewer.evil',
        { isMainFrame: false }
      ),
      false
    );
    assert.equal(
      check(
        handlers,
        webContents,
        'fullscreen',
        'null',
        { isMainFrame: false }
      ),
      false
    );
  });

  it('requires the app shell as the embedding origin', () => {
    const { handlers, webContents } = harness();
    for (const embeddingOrigin of [
      'https://evil.test',
      'null',
      'whale-extension://image-viewer',
      '',
    ]) {
      assert.equal(
        request(
          handlers,
          webContents,
          'fullscreen',
          extensionDetails('image-viewer', embeddingOrigin)
        ),
        false,
        embeddingOrigin
      );
      assert.equal(
        check(
          handlers,
          webContents,
          'fullscreen',
          'whale-extension://image-viewer',
          extensionDetails('image-viewer', embeddingOrigin)
        ),
        false,
        embeddingOrigin
      );
    }
  });

  it('uses the development embedding origin only in development', () => {
    const dev = harness(true);
    assert.equal(
      request(
        dev.handlers,
        dev.webContents,
        'fullscreen',
        extensionDetails('image-viewer', 'http://localhost:4002')
      ),
      true
    );
    const prod = harness();
    assert.equal(
      request(
        prod.handlers,
        prod.webContents,
        'fullscreen',
        extensionDetails('image-viewer', 'http://localhost:4002')
      ),
      false
    );
  });
});

describe('application permissions — webContents binding', () => {
  it('denies a different or missing webContents even with a trusted URL', () => {
    const { handlers } = harness();
    const other = fakeWebContents(PRODUCTION_APP_URL);
    assert.equal(
      request(handlers, other, 'clipboard-sanitized-write', mainDetails()),
      false
    );
    assert.equal(
      check(handlers, other, 'clipboard-sanitized-write', 'file://', mainDetails()),
      false
    );
    assert.equal(
      check(handlers, null, 'clipboard-sanitized-write', 'file://', mainDetails()),
      false
    );
  });

  it('denies destroyed, disappearing and externally navigated main contents', () => {
    const current = harness();
    (current.webContents as unknown as { destroyed: boolean }).destroyed = true;
    assert.equal(
      request(
        current.handlers,
        current.webContents,
        'clipboard-sanitized-write',
        mainDetails()
      ),
      false
    );

    const navigated = harness(false, 'https://evil.test/');
    assert.equal(
      request(
        navigated.handlers,
        navigated.webContents,
        'fullscreen',
        extensionDetails('image-viewer')
      ),
      false
    );
  });

  it('fails closed if webContents inspection throws', () => {
    const webContents = {
      isDestroyed: () => false,
      getURL: () => {
        throw new Error('destroyed between checks');
      },
    } as unknown as WebContents;
    const handlers = createApplicationPermissionHandlers(
      () => webContents,
      false
    );
    assert.equal(
      request(
        handlers,
        webContents,
        'clipboard-sanitized-write',
        mainDetails()
      ),
      false
    );
  });
});

describe('single-instance lock', () => {
  it('quits without bootstrapping when another instance holds the lock', () => {
    let quits = 0;
    loadMain({
      singleInstanceLock: false,
      onQuit: () => {
        quits += 1;
      },
    });
    // Two instances on one userData would double-write index.db / wsd.json and
    // race the MCP port; the second launch must exit before bootstrap() runs
    // (bootstrap would register duplicate IPC handlers and open the same DBs).
    assert.equal(quits, 1);
  });
});
