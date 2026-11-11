import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { act, render, waitFor } from '@testing-library/react';
import globalJsdom from 'global-jsdom';

import type { DirEntry } from '../../shared/ipc-types';

const require_ = createRequire(__filename);

describe('ThumbIcon', () => {
  it('leaves the loading skeleton and falls back to a file icon after a rejected load', async () => {
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

    let rejectLoad!: (error: Error) => void;
    let loadCalls = 0;
    inject('-/services/ipc-api', {
      ipcApi: {
        loadThumbnail: () => {
          loadCalls += 1;
          return new Promise<string | null>((_resolve, reject) => {
            rejectLoad = reject;
          });
        },
      },
    });
    inject('-/services/thumb-load-queue', {
      enqueueThumbLoad: (_key: string, load: () => Promise<void>) => {
        void load().catch(() => undefined);
      },
      cancelThumbLoad: () => undefined,
    });
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(
        private readonly callback: (entries: { isIntersecting: boolean }[]) => void
      ) {}
      observe(): void {
        this.callback([{ isIntersecting: true }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    };

    const componentId = require_.resolve('./ThumbIcon');
    delete require_.cache[componentId];
    const ThumbIcon = require_('./ThumbIcon').default as typeof import('./ThumbIcon').default;
    const entry = {
      name: 'broken.jpg',
      path: '/root/broken.jpg',
      isDirectory: false,
      isFile: true,
      size: 0,
      extension: 'jpg',
      modified: '2026-01-01T00:00:00.000Z',
    } as DirEntry;
    const thumbCache = new Map<string, string>();

    try {
      const view = render(<ThumbIcon entry={entry} thumbCache={thumbCache} size={40} />);
      await waitFor(() => assert.equal(loadCalls, 1));
      assert.ok(
        view.container.querySelector('.MuiSkeleton-root'),
        'file thumbnail is still loading before the rejection'
      );
      await act(async () => {
        rejectLoad(new Error('root temporarily unavailable'));
        await Promise.resolve();
      });
      await waitFor(() =>
        assert.equal(view.container.querySelector('.MuiSkeleton-root'), null)
      );
      assert.ok(view.container.querySelector('svg'), 'file-type glyph replaces the skeleton');
      assert.equal(thumbCache.size, 0, 'failed loads are not cached');
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
