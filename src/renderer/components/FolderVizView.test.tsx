import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React, { forwardRef } from 'react';
import { createRequire } from 'module';
import { act, fireEvent, render } from '@testing-library/react';
import globalJsdom from 'global-jsdom';

import type { DirEntry } from '../../shared/ipc-types';
import type { FileCellData } from './file-cell';

const require_ = createRequire(__filename);

const entries: DirEntry[] = [
  {
    name: 'Docs',
    path: '/root/Docs',
    isDirectory: true,
    isFile: false,
    size: 0,
    extension: '',
    modified: '2026-01-01T00:00:00.000Z',
  },
  {
    name: 'note.txt',
    path: '/root/Docs/note.txt',
    isDirectory: false,
    isFile: true,
    size: 12,
    extension: 'txt',
    modified: '2026-01-01T00:00:00.000Z',
  },
];

describe('FolderVizView directory data', () => {
  it('projects Provider entries without issuing a second recursive scan', async () => {
    const cleanupDom = globalJsdom();
    const saved = new Map<string, NodeJS.Module | undefined>();
    const inject = (spec: string, exports: unknown): void => {
      const id = require_.resolve(spec);
      saved.set(id, require_.cache[id]);
      require_.cache[id] = {
        id,
        filename: id,
        loaded: true,
        exports,
        children: [],
        paths: [],
      } as NodeJS.Module;
    };

    let recursiveScanCalls = 0;
    let refreshCalls = 0;
    let latestOption: unknown;
    const MockChart = forwardRef<unknown, { option: unknown }>((props, _ref) => {
      latestOption = props.option;
      return <div data-testid="folderviz-chart" />;
    });
    MockChart.displayName = 'MockFolderVizChart';

    inject('-/hooks/CurrentLocationContextProvider', {
      useCurrentLocationContext: () => ({
        currentDirectoryPath: '/root',
        currentLocation: { id: 'loc-1', name: 'Test', path: '/root' },
        navigateTo: async () => undefined,
      }),
    });
    inject('-/hooks/DirectoryContentContextProvider', {
      useDirectoryContent: () => ({ entries }),
      useDirectoryUI: () => ({
        loading: false,
        error: null,
        refresh: async () => {
          refreshCalls += 1;
        },
      }),
    });
    inject('react-redux', {
      useSelector: (selector: (state: { settings: { viewDepth: number } }) => unknown) =>
        selector({ settings: { viewDepth: 3 } }),
    });
    inject('-/services/ipc-api', {
      ipcApi: {
        listDirectoryRecursive: async () => {
          recursiveScanCalls += 1;
          return entries;
        },
      },
    });
    inject('-/services/echarts-setup', { echarts: {} });
    inject('echarts-for-react', { __esModule: true, default: MockChart });

    const componentId = require_.resolve('./FolderVizView');
    delete require_.cache[componentId];
    const FolderVizView = require_('./FolderVizView').default as typeof import('./FolderVizView').default;
    const data = {
      onOpen: async () => undefined,
      t: (key: string) => key,
      readOnly: false,
    } as unknown as FileCellData;

    try {
      const view = render(<FolderVizView data={data} />);
      await act(async () => {
        await Promise.resolve();
      });
      assert.equal(recursiveScanCalls, 0, 'Provider owns the only recursive IPC scan');
      const allOption = latestOption;
      assert.ok(allOption, 'the Provider entries produced a chart option');

      fireEvent.click(view.getByRole('button', { name: 'folderVizFilterFile' }));
      assert.equal(recursiveScanCalls, 0, 'filter changes stay in the renderer');
      assert.notEqual(latestOption, allOption, 'filter changes still rebuild the chart');

      fireEvent.click(view.getByRole('button', { name: 'folderVizRefresh' }));
      await act(async () => {
        await Promise.resolve();
      });
      assert.equal(refreshCalls, 1, 'toolbar refresh delegates to the Provider');
      assert.equal(recursiveScanCalls, 0);
      view.unmount();
    } finally {
      delete require_.cache[componentId];
      for (const [id, original] of saved) {
        if (original) require_.cache[id] = original;
        else delete require_.cache[id];
      }
      cleanupDom();
    }
  });
});
