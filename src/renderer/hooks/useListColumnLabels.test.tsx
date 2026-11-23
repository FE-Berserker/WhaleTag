import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@testing-library/react';
import type { TFunction } from 'i18next';

import { listColumnLabels, useListColumnLabels } from './useListColumnLabels';

let cleanupDom: (() => void) | undefined;

before(() => {
  cleanupDom = globalJsdom();
});

afterEach(() => cleanup());
after(() => cleanupDom?.());

/** Stand-in translator: keys map to their English captions. */
function fakeT(labels: Record<string, string> = {}): TFunction {
  const table: Record<string, string> = {
    name: 'Name',
    tags: 'Tags',
    size: 'Size',
    modified: 'Modified',
    ...labels,
  };
  return ((key: string) => table[key] ?? key) as unknown as TFunction;
}

function Probe({
  t,
  seen,
}: {
  t: TFunction;
  seen: { current: ReturnType<typeof useListColumnLabels> | null };
}) {
  seen.current = useListColumnLabels(t);
  return null;
}

describe('listColumnLabels', () => {
  it('maps the four column captions in header order', () => {
    assert.deepEqual(listColumnLabels(fakeT()), {
      name: 'Name',
      tags: 'Tags',
      size: 'Size',
      modified: 'Modified',
    });
  });

  it('follows the active translator (language switches change the captions)', () => {
    const labels = listColumnLabels(fakeT({ name: '名称', modified: '修改日期' }));
    assert.equal(labels.name, '名称');
    assert.equal(labels.modified, '修改日期');
  });
});

/**
 * The memoized header compares `columnLabels` by identity. A fresh object per
 * FileList render (the old inline JSX literal) made that comparison always
 * fail, so the header re-rendered on every selection tick / scroll frame.
 */
describe('useListColumnLabels', () => {
  it('returns the same object across renders for the same translator', () => {
    const t = fakeT();
    const seen = { current: null as ReturnType<typeof useListColumnLabels> | null };
    const view = render(<Probe t={t} seen={seen} />);
    const first = seen.current;
    assert.deepEqual(first, listColumnLabels(t));

    view.rerender(<Probe t={t} seen={seen} />);
    assert.equal(seen.current, first, 'identity must survive a re-render');
  });

  it('returns a new object when the translator changes', () => {
    const seen = { current: null as ReturnType<typeof useListColumnLabels> | null };
    const view = render(<Probe t={fakeT()} seen={seen} />);
    const first = seen.current;

    view.rerender(<Probe t={fakeT({ name: '名称' })} seen={seen} />);
    assert.notEqual(seen.current, first);
    assert.equal(seen.current?.name, '名称');
  });
});
