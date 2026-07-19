/**
 * `useTagDisplayLabels` tests (docs/03 useNow unification).
 *
 * What we lock down:
 *  1. Date-free tags never subscribe to the per-minute store (the whole
 *     point of the conditional gate — chips without date tags pay zero
 *     per-minute re-renders).
 *  2. A date-shaped tag subscribes; labels stay aligned by index (a stale
 *     date tag falls back to its raw string, fresh ones localize).
 *  3. Switching tags from date-shaped to date-free unsubscribes.
 *
 * The `subscribeNow` spy works because the transpiled CommonJS module reads
 * the binding as a property access at call time — the repo's standard
 * node:test + ts-node setup (no jest.mock needed).
 */
import globalJsdom from 'global-jsdom';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useTagDisplayLabels } from './useTagDisplayLabels';
import * as useNowModule from './useNow';

let jsdomCleanup: (() => void) | null = null;

function wrapper({ children }: { children: ReactNode }) {
  return <I18nextProvider i18n={i18next}>{children}</I18nextProvider>;
}

describe('useTagDisplayLabels', () => {
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let origSubscribe: typeof useNowModule.subscribeNow;

  before(async () => {
    jsdomCleanup = globalJsdom() as unknown as () => void;
    await i18next.use(initReactI18next).init({
      resources: { en: { common: {} } },
      lng: 'en',
      fallbackLng: 'en',
      defaultNS: 'common',
      ns: ['common'],
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });

    origSubscribe = useNowModule.subscribeNow;
    (useNowModule as { subscribeNow: unknown }).subscribeNow = (
      cb: () => void
    ) => {
      subscribeCalls += 1;
      const off = origSubscribe(cb);
      return () => {
        unsubscribeCalls += 1;
        off();
      };
    };
  });

  afterEach(() => {
    cleanup();
    subscribeCalls = 0;
    unsubscribeCalls = 0;
  });

  it('date-free tags: raw labels, NO per-minute subscription', () => {
    const { result } = renderHook(
      ({ tags }) => useTagDisplayLabels(tags),
      { wrapper, initialProps: { tags: ['idea', 'work', '1star'] } }
    );
    // 'idea'/'work' pass through raw; '1star' localizes via the i18n key
    // (empty resources → the key itself is returned).
    assert.deepEqual(result.current, ['idea', 'work', 'ratingStars']);
    assert.equal(subscribeCalls, 0);
  });

  it('date-shaped tag present: subscribes, labels stay index-aligned', () => {
    const { result } = renderHook(
      ({ tags }) => useTagDisplayLabels(tags),
      { wrapper, initialProps: { tags: ['idea', 'today-20251223'] } }
    );
    // 'today-20251223' is always stale (past) → falls back to the raw tag;
    // the point under test is the subscription gate + index alignment.
    assert.deepEqual(result.current, ['idea', 'today-20251223']);
    assert.equal(subscribeCalls, 1);
  });

  it('switching tags date-shaped → date-free unsubscribes', () => {
    const { rerender } = renderHook(
      ({ tags }) => useTagDisplayLabels(tags),
      { wrapper, initialProps: { tags: ['today-20251223'] } }
    );
    assert.equal(subscribeCalls, 1);
    assert.equal(unsubscribeCalls, 0);
    rerender({ tags: ['idea'] });
    assert.equal(subscribeCalls, 1, 'no resubscribe');
    assert.equal(unsubscribeCalls, 1, 'gate dropped the subscription');
  });

  it('cleanup: jsdom teardown', () => {
    if (jsdomCleanup) {
      jsdomCleanup();
      jsdomCleanup = null;
    }
  });
});
