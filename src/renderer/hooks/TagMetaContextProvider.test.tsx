import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, render } from '@testing-library/react';
import { Provider as ReduxProvider } from 'react-redux';
import { createStore, type AnyAction, type Store } from 'redux';

import { setTagColors } from '-/reducers/settings';
import { TagMetaContextProvider, useTagMetaContext } from './TagMetaContextProvider';
import * as directoryContextModule from './DirectoryContentContextProvider';
import * as locationContextModule from './CurrentLocationContextProvider';
import * as nowModule from './useNow';

const originalUseDirectoryContent = directoryContextModule.useDirectoryContentContext;
const originalUseCurrentLocation = locationContextModule.useCurrentLocationContext;
const originalSubscribeNow = nowModule.subscribeNow;
const originalGetNowSnapshot = nowModule.getNowSnapshot;

let tagsByName = new Map<string, string[]>();
let currentNow = new Date(2026, 0, 2, 12);
let subscribeCalls = 0;
let unsubscribeCalls = 0;
let latest: ReturnType<typeof useTagMetaContext> | null = null;
const listeners = new Set<() => void>();
let cleanupDom: (() => void) | undefined;

function Probe() {
  latest = useTagMetaContext();
  return null;
}

function makeStore() {
  const actions: AnyAction[] = [];
  const store = createStore((state = { settings: { tagColors: {} } }, action: AnyAction) => {
    actions.push(action);
    return state;
  });
  return { store, actions };
}

function tree(store: Store) {
  return (
    <ReduxProvider store={store}>
      <TagMetaContextProvider>
        <Probe />
      </TagMetaContextProvider>
    </ReduxProvider>
  );
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}${month}${day}`;
}

before(() => {
  cleanupDom = globalJsdom();
  (directoryContextModule as { useDirectoryContentContext: unknown }).useDirectoryContentContext =
    () => ({ tagsByName, refresh: async () => {} });
  (locationContextModule as { useCurrentLocationContext: unknown }).useCurrentLocationContext =
    () => ({ currentDirectoryPath: '/root' });
  (nowModule as { subscribeNow: unknown }).subscribeNow = (listener: () => void) => {
    subscribeCalls += 1;
    listeners.add(listener);
    return () => {
      unsubscribeCalls += 1;
      listeners.delete(listener);
    };
  };
  (nowModule as { getNowSnapshot: unknown }).getNowSnapshot = () => currentNow;
});

afterEach(() => {
  cleanup();
  tagsByName = new Map();
  currentNow = new Date(2026, 0, 2, 12);
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  latest = null;
  listeners.clear();
});

after(() => {
  (directoryContextModule as { useDirectoryContentContext: unknown }).useDirectoryContentContext =
    originalUseDirectoryContent;
  (locationContextModule as { useCurrentLocationContext: unknown }).useCurrentLocationContext =
    originalUseCurrentLocation;
  (nowModule as { subscribeNow: unknown }).subscribeNow = originalSubscribeNow;
  (nowModule as { getNowSnapshot: unknown }).getNowSnapshot = originalGetNowSnapshot;
  cleanupDom?.();
});

describe('TagMetaContextProvider conditional now subscription', () => {
  it('does not subscribe for ordinary, rating, or period-only tags', () => {
    const { store, actions } = makeStore();
    tagsByName = new Map([
      ['/root/a.md', ['idea', '1star']],
      ['/root/b.md', ['20260701-20260702']],
    ]);
    render(tree(store));

    assert.equal(subscribeCalls, 0);
    assert.equal(listeners.size, 0);
    assert.deepEqual(
      Object.fromEntries(latest?.allTags.map(({ tag, count }) => [tag, count])),
      { idea: 1, 'smart:star1': 1, 'period:': 1 }
    );

    const colorActionType = setTagColors({}).type;
    const colorAction = actions.find((action) => action.type === colorActionType);
    assert.ok(colorAction, 'ordinary tags still receive automatic colors');
    const colors = (colorAction as AnyAction & { payload: Record<string, string> }).payload;
    assert.deepEqual(Object.keys(colors).sort(), ['idea', 'period:', 'smart:star1']);
    assert.equal(new Set(Object.values(colors)).size, 3);
  });

  it('keeps minute ticks driving fresh-to-stale date folding', () => {
    currentNow = new Date(2026, 0, 2, 12);
    tagsByName = new Map([['/root/a.md', [`today-${dayKey(currentNow)}`]]]);
    const { store } = makeStore();
    render(tree(store));

    assert.equal(subscribeCalls, 1);
    assert.equal(listeners.size, 1);
    assert.deepEqual(latest?.allTags, [{ tag: 'smart:today', count: 1 }]);

    act(() => {
      currentNow = new Date(2026, 0, 3, 12);
      for (const listener of listeners) listener();
    });

    assert.equal(subscribeCalls, 1, 'a tick reuses the existing subscription');
    assert.deepEqual(latest?.allTags, [{ tag: 'smart:yesterday', count: 1 }]);

    act(() => {
      currentNow = new Date(2026, 0, 4, 12);
      for (const listener of listeners) listener();
    });
    assert.equal(subscribeCalls, 1);
    assert.deepEqual(latest?.allTags, [{ tag: 'date:', count: 1 }]);
  });

  it('subscribes and unsubscribes as date tags enter and leave', () => {
    tagsByName = new Map([['/root/a.md', ['idea']]]);
    const { store } = makeStore();
    const view = render(tree(store));
    assert.equal(subscribeCalls, 0);

    tagsByName = new Map([['/root/a.md', ['today-20200101']]]);
    view.rerender(tree(store));
    assert.equal(subscribeCalls, 1);
    assert.equal(listeners.size, 1);
    assert.deepEqual(latest?.allTags, [{ tag: 'date:', count: 1 }]);

    tagsByName = new Map([['/root/a.md', ['20260701-20260702']]]);
    view.rerender(tree(store));
    assert.equal(unsubscribeCalls, 1);
    assert.equal(listeners.size, 0);

    tagsByName = new Map([['/root/a.md', ['today-20200101']]]);
    view.rerender(tree(store));
    assert.equal(subscribeCalls, 2);
    assert.equal(listeners.size, 1);

    view.unmount();
    assert.equal(unsubscribeCalls, 2);
    assert.equal(listeners.size, 0);
  });
});
