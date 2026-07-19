import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  estChipWidth,
  packTagRows,
  estListHeight,
  EST_CHIP_ROW_HEIGHT,
  EST_CLUSTER_ROW_HEIGHT,
} from './tag-library-pack';

describe('estChipWidth', () => {
  it('grows with tag length, counts CJK double, includes digits + base', () => {
    const latin = estChipWidth('idea', 12);
    const longer = estChipWidth('idea-longer-tag', 12);
    assert.ok(longer > latin);
    const cjk = estChipWidth('工作', 12);
    assert.ok(cjk > estChipWidth('ab', 12)); // 2 CJK ≈ 4 latin units
    const bigCount = estChipWidth('idea', 1234);
    assert.ok(bigCount > latin); // more digits
  });
});

describe('packTagRows', () => {
  const tags = (widths: string[]): { tag: string; count: number }[] =>
    widths.map((t) => ({ tag: t, count: 1 }));

  it('packs greedily within the container budget', () => {
    const rows = packTagRows(tags(['aaaa', 'bbbb', 'cccc', 'dddd']), 200);
    let total = 0;
    for (const r of rows) total += r.tags.length;
    assert.equal(total, 4, 'all tags placed');
    // every row except possibly the last respects the budget
    for (const r of rows.slice(0, -1)) {
      const w = r.tags.reduce((acc, t) => acc + estChipWidth(t.tag, t.count) + 6, -6);
      assert.ok(w <= 200, `row width ${w} <= 200`);
    }
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(packTagRows([], 200), []);
  });

  it('a chip wider than the container gets its own row', () => {
    const rows = packTagRows(tags(['x'.repeat(60), 'a']), 100);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tags[0].tag, 'x'.repeat(60));
    assert.equal(rows[1].tags[0].tag, 'a');
  });

  it('very narrow container still yields one chip per row (no infinite loop)', () => {
    const rows = packTagRows(tags(['aa', 'bb', 'cc']), 10);
    assert.equal(rows.length, 3);
  });

  it('single exact-fit row stays on one row', () => {
    const one = packTagRows(tags(['aaaa']), 400);
    assert.equal(one.length, 1);
    assert.equal(one[0].tags.length, 1);
  });
});

describe('estListHeight', () => {
  it('sums chip rows and the cluster row at their estimates', () => {
    const h = estListHeight([
      { kind: 'cluster' },
      { kind: 'chips', tags: [{ tag: 'a', count: 1 }] },
      { kind: 'chips', tags: [{ tag: 'b', count: 2 }] },
    ]);
    assert.equal(h, EST_CLUSTER_ROW_HEIGHT + 2 * EST_CHIP_ROW_HEIGHT);
  });

  it('is 0 for no rows', () => {
    assert.equal(estListHeight([]), 0);
  });
});
