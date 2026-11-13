/**
 * Application menu structure (docs/01 §12).
 *
 * The menu is built from a platform-dependent template; a wrong role on the
 * wrong platform is a UX-only regression that no other test would catch
 * (macOS keeps `close` in File and `front` in Window, Windows/Linux keep
 * `quit`). Electron's `Menu.buildFromTemplate` is stubbed so the assertions
 * run against the template instead of a native menu that cannot exist in a
 * headless test process.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require_ = createRequire(__filename);

interface MenuItemLike {
  label?: string;
  role?: string;
  type?: string;
  submenu?: MenuItemLike[];
}

let capturedTemplate: MenuItemLike[] | null = null;

const SAVED_CACHE = new Map<string, NodeJS.Module | undefined>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  if (!SAVED_CACHE.has(modulePath)) {
    SAVED_CACHE.set(modulePath, require_.cache[modulePath]);
  }
  const existing = require_.cache[modulePath];
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

function restoreMocks(): void {
  for (const [modulePath, original] of SAVED_CACHE.entries()) {
    if (original) {
      require_.cache[modulePath] = original;
    } else {
      delete require_.cache[modulePath];
    }
  }
  SAVED_CACHE.clear();
  delete require_.cache[require_.resolve('./menu')];
}

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function buildTemplate(): MenuItemLike[] {
  capturedTemplate = null;
  const electronStub = {
    app: { name: 'Whale' },
    Menu: {
      buildFromTemplate: (template: MenuItemLike[]): { template: MenuItemLike[] } => {
        capturedTemplate = template;
        return { template };
      },
    },
  };
  injectMock('electron', electronStub);
  const mod = require_('./menu') as { buildMenu: () => unknown };
  mod.buildMenu();
  assert.ok(capturedTemplate, 'buildMenu must call Menu.buildFromTemplate');
  return capturedTemplate;
}

function labels(template: MenuItemLike[]): (string | undefined)[] {
  return template.map((item) => item.label);
}

function roles(template: MenuItemLike[], label: string): (string | undefined)[] {
  const menu = template.find((item) => item.label === label);
  assert.ok(menu, `menu ${label} exists`);
  return (menu.submenu ?? []).map((item) => item.role);
}

beforeEach(() => {
  restoreMocks();
});

afterEach(() => {
  restoreMocks();
  setPlatform(originalPlatform);
});

describe('buildMenu — Windows/Linux template', () => {
  it('starts with File and keeps quit in File and Window', () => {
    setPlatform('win32');
    const template = buildTemplate();

    assert.deepEqual(labels(template), ['File', 'Edit', 'View', 'Window']);
    assert.deepEqual(roles(template, 'File'), ['quit']);
    assert.ok(roles(template, 'Window').includes('quit'));
    assert.ok(!roles(template, 'Window').includes('front'));
  });

  it('View exposes reload/zoom/fullscreen accelerators', () => {
    setPlatform('linux');
    const template = buildTemplate();

    const view = roles(template, 'View');
    for (const role of [
      'reload',
      'forceReload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]) {
      assert.ok(view.includes(role), `View must expose ${role}`);
    }
  });
});

describe('buildMenu — macOS template', () => {
  it('prepends the app menu and swaps quit for close/front', () => {
    setPlatform('darwin');
    const template = buildTemplate();

    assert.deepEqual(labels(template), ['Whale', 'File', 'Edit', 'View', 'Window']);
    assert.deepEqual(roles(template, 'File'), ['close']);
    assert.ok(roles(template, 'Window').includes('front'));
    assert.ok(!roles(template, 'Window').includes('quit'));
    assert.deepEqual(roles(template, 'Whale'), [
      'about',
      undefined,
      'services',
      undefined,
      'hide',
      'hideOthers',
      'unhide',
      undefined,
      'quit',
    ]);
  });
});
