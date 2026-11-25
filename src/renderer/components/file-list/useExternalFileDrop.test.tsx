/**
 * Co-located tests for `useExternalFileDrop` (OS-file drop target).
 *
 * react-dnd memoizes the drop spec by its dependency array and invokes
 * `drop` / `canDrop` from THAT closure. jsdom cannot drive the HTML5
 * backend's drag pipeline (see GalleryView.test.tsx), so `useDrop` is replaced
 * by a faithful fake that applies the SAME memo semantics
 * (`useMemo(factory, deps)`) and hands the resulting spec to the test — which
 * is exactly the surface where the stale-closure bug lived: a spec memoized
 * in list view kept a frozen `viewMode` after the user switched to task view.
 */
import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useMemo } from 'react';

type TestingLibrary = typeof import('@testing-library/react');
let act: TestingLibrary['act'];
let cleanup: TestingLibrary['cleanup'];
let render: TestingLibrary['render'];

type HookModule = typeof import('./useExternalFileDrop');
type Hook = HookModule['useExternalFileDrop'];
type Options = Parameters<Hook>[0];

interface FakeSpec {
  canDrop: () => boolean;
  drop: (item: { files: File[] }) => void;
  collect: unknown;
}

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let useExternalFileDrop: Hook;
/** The most recent drop spec react-dnd would hold (memoized by deps). */
let latestSpec: FakeSpec | null = null;

const importCalls: Array<{ files: File[]; tagToApply: string | null }> = [];
let importResult: { copied: number; errors: string[] } = {
  copied: 1,
  errors: [],
};
let importError: Error | null = null;
const notices: Array<[string, string | undefined]> = [];
// The hook takes the real i18next `t`; the stub only echoes key + options.
const t = ((key: string, opts?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(opts ?? {})}`) as unknown as Options['t'];

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

function restore(): void {
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
  savedModules.clear();
}

function Probe(props: Partial<Options>) {
  useExternalFileDrop({
    viewMode: 'list',
    currentDirectoryPath: '/root',
    readOnly: false,
    importExternalFiles: async (files, options) => {
      importCalls.push({ files, tagToApply: options?.tagToApply ?? null });
      if (importError) throw importError;
      return importResult;
    },
    showNotice: (text, severity) => notices.push([text, severity]),
    t,
    ...props,
  });
  return null;
}

before(async () => {
  cleanupDom = globalJsdom();
  ({ act, cleanup, render } = await import('@testing-library/react'));
  inject('react-dnd', {
    useDrop: (factory: () => unknown, deps: unknown[]) => {
      // Same memo semantics as react-dnd's useDrop: the spec lives exactly as
      // long as `deps` does, and its closures see only that render's values.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the array IS the argument react-dnd received
      const spec = useMemo(factory, deps as React.DependencyList) as FakeSpec;
      latestSpec = spec;
      return [{ isFileOver: false }, (node: unknown) => node];
    },
  });
  const hookId = require_.resolve('./useExternalFileDrop');
  delete require_.cache[hookId];
  ({ useExternalFileDrop } = require_('./useExternalFileDrop') as HookModule);
});

after(() => {
  restore();
  cleanupDom?.();
});

afterEach(() => {
  cleanup();
  latestSpec = null;
  importCalls.length = 0;
  importError = null;
  importResult = { copied: 1, errors: [] };
  notices.length = 0;
});

async function dropOnce(): Promise<void> {
  assert.ok(latestSpec, 'useDrop must have produced a spec');
  const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
  await act(async () => {
    latestSpec!.drop({ files: [file] });
  });
}

describe('useExternalFileDrop', () => {
  it('task-view drops stamp the today period even when the spec was memoized in list view', async () => {
    // Memoized here: deps are [readOnly, currentDirectoryPath], neither of
    // which changes on a list → task switch. Before the latest-ref fix the
    // spec kept `viewMode: 'list'` and the drop imported WITHOUT a period tag,
    // so the file never reached the Gantt timeline.
    const view = render(<Probe viewMode="list" />);
    const specAtList = latestSpec;
    view.rerender(<Probe viewMode="task" />);
    assert.equal(latestSpec, specAtList, 'deps unchanged → react-dnd keeps the spec');

    await dropOnce();
    assert.equal(importCalls.length, 1);
    assert.equal(importCalls[0].tagToApply !== null, true, 'period tag applied in task view');
    // periodTagFromRange for a single day → `<today>-<today>`.
    assert.match(String(importCalls[0].tagToApply), /^\d{8}-\d{8}$/);
    assert.deepEqual(notices, [['importedItems:{"count":1}', 'success']]);
  });

  it('list-view drops carry NO period tag even after a visit to task view', async () => {
    const view = render(<Probe viewMode="task" />);
    view.rerender(<Probe viewMode="list" />);

    await dropOnce();
    assert.equal(importCalls.length, 1);
    assert.equal(importCalls[0].tagToApply, null);
  });

  it('surfaces the first import error or a thrown message through showNotice', async () => {
    render(<Probe viewMode="list" />);
    importResult = { copied: 0, errors: ['EEXIST: a.txt'] };
    await dropOnce();
    assert.deepEqual(notices, [['EEXIST: a.txt', undefined]]);

    importError = new Error('boom');
    await dropOnce();
    assert.deepEqual(notices[notices.length - 1], ['boom', undefined]);
  });

  it('ignores empty drops and drops without a current directory', async () => {
    render(<Probe viewMode="list" />);
    await act(async () => {
      latestSpec!.drop({ files: [] });
    });
    assert.equal(importCalls.length, 0);
  });

  it('canDrop follows the latest readOnly flag', () => {
    const view = render(<Probe readOnly={false} />);
    assert.equal(latestSpec!.canDrop(), true);
    view.rerender(<Probe readOnly />);
    assert.equal(latestSpec!.canDrop(), false, 'read-only locations refuse drops');
  });
});
