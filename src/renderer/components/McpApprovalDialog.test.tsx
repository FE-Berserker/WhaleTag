import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import type { McpApprovalRequest } from '../../shared/mcp-types';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let Dialog: typeof import('./McpApprovalDialog').default;

let pushApproval: (req: McpApprovalRequest) => void = () => undefined;
let pendingImpl: () => Promise<McpApprovalRequest[]> = async () => [];
let resolveImpl: (
  reqId: string,
  allowed: boolean
) => Promise<{ ok: true; settled: boolean }> = async () => ({
  ok: true,
  settled: true,
});
let resolveCalls: Array<[string, boolean]> = [];
let notices: Array<{ message: string; severity: string }> = [];
let unsubscribeNotices: (() => void) | null = null;
let pendingCalls = 0;

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
  } as NodeJS.Module;
}

function request(overrides: Partial<McpApprovalRequest> = {}): McpApprovalRequest {
  return {
    reqId: 'req-1',
    tool: 'whale_move_files',
    summary: 'Move 2 items to D:\\docs',
    details: ['D:\\a.txt -> D:\\docs\\a.txt'],
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function renderDialog() {
  return render(
    <I18nextProvider i18n={i18next}>
      <Dialog />
    </I18nextProvider>
  );
}

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          mcpApproveTitle: 'Approve file operation',
          mcpApproveIntro: 'An external AI client ({{tool}}) requests:',
          mcpApproveAllow: 'Allow',
          mcpApproveDeny: 'Deny',
          mcpApproveExpiresIn: 'Expires in {{seconds}}s',
          mcpApproveExpired: 'That approval request already expired.',
          mcpApproveFailed: 'Could not send the answer: {{message}}',
          operationFailed: 'Operation failed: {{message}}',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  inject('-/services/ipc-api', {
    ipcApi: {
      onMcpApprovalRequest: (cb: (req: McpApprovalRequest) => void) => {
        pushApproval = cb;
        return () => undefined;
      },
      mcpPendingApprovals: () => {
        pendingCalls += 1;
        return pendingImpl();
      },
      mcpResolveApproval: (reqId: string, allowed: boolean) => {
        resolveCalls.push([reqId, allowed]);
        return resolveImpl(reqId, allowed);
      },
    },
  });

  const appNotice = await import('-/services/app-notice');
  unsubscribeNotices = appNotice.subscribeAppNotices((notice) =>
    notices.push({ message: notice.message, severity: notice.severity })
  );

  Dialog = (await import('./McpApprovalDialog')).default;
});

afterEach(() => {
  cleanup();
  resolveCalls = [];
  notices = [];
  pendingCalls = 0;
  pendingImpl = async () => [];
  resolveImpl = async () => ({ ok: true, settled: true });
});

after(() => {
  unsubscribeNotices?.();
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('McpApprovalDialog', () => {
  it('shows a request pushed after mount', async () => {
    renderDialog();
    assert.equal(document.body.textContent?.includes('Move 2 items'), false);

    await act(async () => {
      pushApproval(request({ reqId: 'r-push', summary: 'Delete 1 item' }));
    });

    await waitFor(() => {
      assert.ok(document.body.textContent?.includes('Delete 1 item'));
    });
  });

  it('adopts a pending request on mount and shows the countdown', async () => {
    pendingImpl = async () => [request()];
    renderDialog();

    await waitFor(() => {
      assert.ok(document.body.textContent?.includes('Move 2 items to D:\\docs'));
    });
    assert.match(document.body.textContent ?? '', /Expires in 60s/);
    assert.ok(pendingCalls >= 1);
  });

  it('sends the answer and hides the dialog once main settled it', async () => {
    pendingImpl = async () => [request({ reqId: 'r-allow' })];
    renderDialog();
    await waitFor(() => assert.ok(document.body.textContent?.includes('Allow')));

    fireEvent.click(
      Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Allow')
      ) as HTMLButtonElement
    );

    await waitFor(() => {
      assert.deepEqual(resolveCalls, [['r-allow', true]]);
      assert.ok(!document.body.textContent?.includes('Move 2 items'));
    });
  });

  it('keeps the request visible and reports when the answer cannot be sent', async () => {
    pendingImpl = async () => [request({ reqId: 'r-fail' })];
    resolveImpl = async () => {
      throw new Error('ipc exploded');
    };
    renderDialog();
    await waitFor(() => assert.ok(document.body.textContent?.includes('Deny')));

    fireEvent.click(
      Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Deny')
      ) as HTMLButtonElement
    );

    await waitFor(() => {
      assert.ok(
        notices.some((n) => n.message.includes('Could not send the answer')),
        `notices: ${JSON.stringify(notices)}`
      );
    });
    // The client is still blocked, so the dialog must not disappear.
    assert.ok(document.body.textContent?.includes('Move 2 items'));
    // …and it reconciles against main after the failure.
    assert.ok(pendingCalls >= 2);
  });

  it('tells the user when the request had already expired', async () => {
    pendingImpl = async () => [request({ reqId: 'r-gone' })];
    resolveImpl = async () => ({ ok: true, settled: false });
    renderDialog();
    await waitFor(() => assert.ok(document.body.textContent?.includes('Deny')));

    fireEvent.click(
      Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Deny')
      ) as HTMLButtonElement
    );

    await waitFor(() => {
      assert.ok(
        notices.some((n) => n.message.includes('already expired')),
        `notices: ${JSON.stringify(notices)}`
      );
    });
    assert.ok(!document.body.textContent?.includes('Move 2 items'));
  });

  it('disables both answers while one is in flight', async () => {
    pendingImpl = async () => [request({ reqId: 'r-slow' })];
    let release: (value: { ok: true; settled: boolean }) => void = () => undefined;
    resolveImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    renderDialog();
    await waitFor(() => assert.ok(document.body.textContent?.includes('Allow')));

    const allow = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Allow')
    ) as HTMLButtonElement;
    fireEvent.click(allow);

    await waitFor(() => assert.equal(allow.disabled, true));
    const deny = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Deny')
    ) as HTMLButtonElement;
    assert.equal(deny.disabled, true);

    release({ ok: true, settled: true });
    await waitFor(() => assert.ok(!document.body.textContent?.includes('Move 2 items')));
  });
});
