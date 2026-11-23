import globalJsdom from 'global-jsdom';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { LanStatus } from '../../shared/lan-types';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
const qrValues: string[] = [];
const copiedValues: string[] = [];
let cleanupDom: (() => void) | undefined;
let LanSettings: typeof import('./LanSettings').default;
let originalWhale: PropertyDescriptor | undefined;
let originalClipboard: PropertyDescriptor | undefined;

const STOPPED: LanStatus = {
  running: false,
  port: null,
  urls: [],
  token: null,
};
const RUNNING: LanStatus = {
  running: true,
  port: 47821,
  urls: ['http://192.168.1.20:47821', 'http://10.0.0.8:47821'],
  token: 'session secret/+',
};

let status: LanStatus = STOPPED;
let getStatusCalls = 0;
let getStatus: () => Promise<LanStatus>;
let startServer: () => Promise<LanStatus>;
let stopServer: () => Promise<LanStatus>;

function inject(spec: string, exports: unknown): void {
  const id = require_.resolve(spec);
  if (!savedModules.has(id)) savedModules.set(id, require_.cache[id]);
  require_.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

function renderLanSettings() {
  return render(
    <I18nextProvider i18n={i18next}>
      <LanSettings />
    </I18nextProvider>
  );
}

before(async () => {
  cleanupDom = globalJsdom();
  originalWhale = Object.getOwnPropertyDescriptor(window, 'whale');
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          lanTitle: 'LAN sharing',
          lanHint: 'Browse this library from another device.',
          lanSecurityWarning:
            'Same Wi-Fi only. Read-only access. The token is session-scoped.',
          lanStatusError: 'Could not check LAN status: {{message}}',
          lanStartError: 'Could not start LAN sharing: {{message}}',
          lanStopError: 'Could not stop LAN sharing: {{message}}',
          lanCopyError: 'Could not copy the pairing link: {{message}}',
          lanQrError: 'Could not generate the QR code: {{message}}',
          lanStart: 'Start LAN sharing',
          lanStarting: 'Starting…',
          lanStop: 'Stop LAN sharing',
          lanStopping: 'Stopping…',
          lanRunning: 'Running',
          lanStopped: 'Stopped',
          lanLoading: 'Checking LAN status…',
          lanBaseUrl: 'Base URL',
          lanCopyLink: 'Copy pairing link',
          lanLinkCopied: 'Pairing link copied',
          lanQrCode: 'QR code for LAN pairing',
          retry: 'Retry',
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  inject('qrcode', {
    toDataURL: async (value: string) => {
      qrValues.push(value);
      return 'data:image/png;base64,bW9ja2VkLXFy';
    },
  });
  LanSettings = (await import('./LanSettings')).default;
});

beforeEach(() => {
  status = STOPPED;
  getStatusCalls = 0;
  getStatus = async () => status;
  startServer = async () => {
    status = RUNNING;
    return status;
  };
  stopServer = async () => {
    status = STOPPED;
    return status;
  };
  Object.defineProperty(window, 'whale', {
    configurable: true,
    value: {
      getLanStatus: () => {
        getStatusCalls += 1;
        return getStatus();
      },
      startLanServer: () => startServer(),
      stopLanServer: () => stopServer(),
    },
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedValues.push(value);
      },
    },
  });
  qrValues.length = 0;
  copiedValues.length = 0;
});

afterEach(() => {
  cleanup();
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (originalWhale) Object.defineProperty(window, 'whale', originalWhale);
  else Reflect.deleteProperty(window, 'whale');
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('LanSettings', () => {
  it('defaults to stopped and does not load a QR encoder while stopped', async () => {
    const view = renderLanSettings();

    assert.equal(view.getByRole('status').textContent, 'Stopped');
    const start = view.getByRole('button', {
      name: 'Start LAN sharing',
    }) as HTMLButtonElement;
    await waitFor(() => assert.equal(start.disabled, false));
    assert.equal(view.queryByRole('button', { name: 'Copy pairing link' }), null);
    assert.equal(view.queryByRole('combobox'), null);
    assert.equal(qrValues.length, 0);
  });

  it('starts, selects a base URL, copies the full pairing link, renders QR, and stops', async () => {
    const view = renderLanSettings();
    const start = view.getByRole('button', {
      name: 'Start LAN sharing',
    }) as HTMLButtonElement;
    await waitFor(() => assert.equal(start.disabled, false));
    fireEvent.click(start);

    await waitFor(() =>
      view.getByRole('button', { name: 'Stop LAN sharing' })
    );
    const firstLink = `${RUNNING.urls[0]}#token=${encodeURIComponent(
      RUNNING.token!
    )}`;
    await waitFor(() => assert.deepEqual(qrValues, [firstLink]));
    assert.equal(
      view.getByRole('img', { name: 'QR code for LAN pairing' }).getAttribute('src'),
      'data:image/png;base64,bW9ja2VkLXFy'
    );

    const selector = view.getByRole('combobox', { name: 'Base URL' });
    fireEvent.mouseDown(selector);
    fireEvent.click(view.getByRole('option', { name: RUNNING.urls[1] }));
    const secondLink = `${RUNNING.urls[1]}#token=${encodeURIComponent(
      RUNNING.token!
    )}`;
    await waitFor(() => assert.equal(qrValues.at(-1), secondLink));

    fireEvent.click(view.getByRole('button', { name: 'Copy pairing link' }));
    await waitFor(() => assert.deepEqual(copiedValues, [secondLink]));
    view.getByText('Pairing link copied');
    assert.equal(view.container.textContent?.includes(RUNNING.token!), false);

    fireEvent.click(view.getByRole('button', { name: 'Stop LAN sharing' }));
    await waitFor(() =>
      view.getByRole('button', { name: 'Start LAN sharing' })
    );
    assert.equal(view.queryByRole('img'), null);
    assert.equal(view.queryByRole('combobox'), null);
    assert.equal(view.container.textContent?.includes(RUNNING.token!), false);
  });

  it('polls every two seconds, shows failures, and clears stale QR after automatic stop', async (context) => {
    let poll: (() => void) | undefined;
    let intervalMs: number | undefined;
    context.mock.method(
      window,
      'setInterval',
      ((callback: () => void, ms?: number) => {
        poll = callback;
        intervalMs = ms;
        return 1;
      }) as typeof window.setInterval
    );
    const clearInterval = context.mock.method(
      window,
      'clearInterval',
      () => undefined
    );
    status = RUNNING;
    getStatus = async () => {
      if (getStatusCalls === 2) throw new Error('network changed');
      return status;
    };
    const view = renderLanSettings();
    await waitFor(() => assert.equal(getStatusCalls, 1));
    await waitFor(() => assert.equal(qrValues.length, 1));
    await waitFor(() => assert.equal(typeof poll, 'function'));
    assert.equal(intervalMs, 2000);
    assert.equal(getStatusCalls, 1);

    await act(async () => poll?.());
    await view.findByText('Could not check LAN status: network changed');
    assert.equal(view.container.textContent?.includes(RUNNING.token!), false);
    view.getByRole('img', { name: 'QR code for LAN pairing' });

    status = STOPPED;
    await act(async () => poll?.());
    await waitFor(() => assert.equal(getStatusCalls, 3));
    await waitFor(() =>
      view.getByRole('button', { name: 'Start LAN sharing' })
    );
    assert.equal(view.queryByRole('img'), null);
    assert.equal(view.queryByRole('button', { name: 'Copy pairing link' }), null);
    assert.equal(view.container.textContent?.includes(RUNNING.token!), false);
    assert.equal(clearInterval.mock.callCount(), 1);
  });

  it('shows an initial status error without leaving the stopped state', async () => {
    getStatus = async () => {
      throw new Error('IPC unavailable');
    };
    const view = renderLanSettings();

    await view.findByText('Could not check LAN status: IPC unavailable');
    assert.equal(view.getByRole('status').textContent, 'Stopped');
    // A status read is retryable; the alert offers it without leaving the page.
    view.getByRole('button', { name: 'Retry' });
  });

  it('clears a poll error once a later poll succeeds', async (context) => {
    let poll: (() => void) | undefined;
    context.mock.method(
      window,
      'setInterval',
      ((callback: () => void) => {
        poll = callback;
        return 1;
      }) as typeof window.setInterval
    );
    context.mock.method(window, 'clearInterval', () => undefined);
    status = RUNNING;
    let calls = 0;
    getStatus = async () => {
      calls += 1;
      if (calls === 2) throw new Error('network changed');
      return status;
    };
    const view = renderLanSettings();
    await waitFor(() => assert.equal(typeof poll, 'function'));
    await act(async () => poll?.());
    await view.findByText('Could not check LAN status: network changed');

    await act(async () => poll?.());
    await waitFor(() =>
      assert.equal(
        view.queryByText('Could not check LAN status: network changed'),
        null
      )
    );
    // The server is still running; only the transient error went away.
    view.getByRole('button', { name: 'Stop LAN sharing' });
    assert.equal(view.queryByRole('button', { name: 'Retry' }), null);
  });

  it('pauses polling after three consecutive failures and recovers via Retry', async (context) => {
    let poll: (() => void) | undefined;
    context.mock.method(
      window,
      'setInterval',
      ((callback: () => void) => {
        poll = callback;
        return 1;
      }) as typeof window.setInterval
    );
    const clearInterval = context.mock.method(
      window,
      'clearInterval',
      () => undefined
    );
    status = RUNNING;
    let calls = 0;
    getStatus = async () => {
      calls += 1;
      if (calls === 1) return status;
      throw new Error('main unreachable');
    };
    const view = renderLanSettings();
    await waitFor(() => assert.equal(typeof poll, 'function'));

    for (let i = 0; i < 3; i += 1) {
      await act(async () => poll?.());
    }
    await view.findByText('Could not check LAN status: main unreachable');
    // Third failure stops the interval instead of hammering an unreachable
    // main process every 2 s forever.
    assert.equal(clearInterval.mock.callCount(), 1);

    getStatus = async () => status;
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      assert.equal(
        view.queryByText('Could not check LAN status: main unreachable'),
        null
      )
    );
    view.getByRole('button', { name: 'Stop LAN sharing' });
  });

  it('shows a start failure and keeps the stopped controls available', async () => {
    startServer = async () => {
      throw new Error('port busy');
    };
    const view = renderLanSettings();
    const start = view.getByRole('button', {
      name: 'Start LAN sharing',
    }) as HTMLButtonElement;
    await waitFor(() => assert.equal(start.disabled, false));
    fireEvent.click(start);

    await view.findByText('Could not start LAN sharing: port busy');
    view.getByRole('button', { name: 'Start LAN sharing' });
    assert.equal(view.container.textContent?.includes(RUNNING.token!), false);
  });

  it('shows a stop failure and keeps the running pairing controls available', async () => {
    status = RUNNING;
    stopServer = async () => {
      throw new Error('server busy');
    };
    const view = renderLanSettings();
    await waitFor(() =>
      view.getByRole('button', { name: 'Stop LAN sharing' })
    );
    fireEvent.click(view.getByRole('button', { name: 'Stop LAN sharing' }));

    await view.findByText('Could not stop LAN sharing: server busy');
    view.getByRole('button', { name: 'Stop LAN sharing' });
    view.getByRole('button', { name: 'Copy pairing link' });
    assert.equal(view.container.textContent?.includes(RUNNING.token!), false);
  });
});
