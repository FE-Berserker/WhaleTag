import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTagColor,
  pickTagColor,
  readableTextOn,
  RATING_COLOR,
  PERIOD_COLOR,
  STALE_DATE_FOLD_COLOR,
  TAG_PALETTE,
  TAG_SHAPES,
  tagShapeSx,
  tagShapeBoxPadding,
} from './tag-colors';
import type { TagGroup } from './tag-library';

describe('tag-colors', () => {
  describe('getTagColor', () => {
    it('returns a uniform gold color for all rating tags', () => {
      for (let i = 1; i <= 5; i += 1) {
        assert.equal(
          getTagColor(`${i}star`, {}, []),
          RATING_COLOR,
          `${i}star should be uniform gold`
        );
      }
    });

    it('ignores per-tag color overrides for rating tags', () => {
      assert.equal(
        getTagColor('5star', { '5star': '#0000ff' }, []),
        RATING_COLOR,
        '5star should stay gold even if user set blue'
      );
    });

    it('ignores group color inheritance for rating tags', () => {
      const groups: TagGroup[] = [
        { id: 'g1', title: 'Ratings', expanded: true, color: '#3b82f6', tags: ['5star'] },
      ];
      assert.equal(
        getTagColor('5star', {}, groups),
        RATING_COLOR,
        '5star should stay gold even inside a blue group'
      );
    });

    it('returns user-defined per-tag colors for ordinary tags', () => {
      assert.equal(
        getTagColor('project', { project: '#ff0000' }, []),
        '#ff0000'
      );
    });

    it('falls back to group color for ordinary tags', () => {
      const groups: TagGroup[] = [
        { id: 'g1', title: 'Projects', expanded: true, color: '#00ff00', tags: ['project'] },
      ];
      assert.equal(getTagColor('project', {}, groups), '#00ff00');
    });

    it('prefers per-tag color over group color for ordinary tags', () => {
      const groups: TagGroup[] = [
        { id: 'g1', title: 'Projects', expanded: true, color: '#00ff00', tags: ['project'] },
      ];
      assert.equal(
        getTagColor('project', { project: '#ff0000' }, groups),
        '#ff0000'
      );
    });

    it('returns undefined for unknown ordinary tags', () => {
      assert.equal(getTagColor('unknown', {}, []), undefined);
    });

    it('returns geo color for geo tags', () => {
      const color = getTagColor('geo:31.2304,121.4737', {}, []);
      assert.ok(color, 'geo tag has a color');
      assert.notEqual(color, RATING_COLOR);
    });

    it('returns PERIOD_COLOR for valid period tags (Phase 2 §6)', () => {
      assert.equal(getTagColor('20260701-20260703', {}, []), PERIOD_COLOR);
      // Reversed input still parsed by dateTagRangeKey
      assert.equal(getTagColor('20260710-20260701', {}, []), PERIOD_COLOR);
    });

    it('does NOT apply PERIOD_COLOR to plain 8-digit day tags (only true periods)', () => {
      // `20260704` is a bare day (matches dateTagDayKey) but is NOT a period
      // (dateTagRangeKey returns null), so it falls through to the unknown
      // branch and gets no built-in color.
      assert.equal(getTagColor('20260704', {}, []), undefined);
    });

    it('period color is overridable by per-tag / group color (unlike rating)', () => {
      // Phase 2 spec: period is overridable. Different from rating's
      // "always uniform not overridable" behavior.
      assert.equal(
        getTagColor('20260701-20260703', { '20260701-20260703': '#ff0000' }, []),
        '#ff0000'
      );
      const groups: TagGroup[] = [
        {
          id: 'g1',
          title: 'My Periods',
          expanded: true,
          color: '#00ff00',
          tags: ['20260701-20260703'],
        },
      ];
      assert.equal(
        getTagColor('20260701-20260703', {}, groups),
        '#00ff00'
      );
    });
  });

  describe('STALE_DATE_FOLD_COLOR (Phase 3 / §9)', () => {
    it('is exported and is a non-empty hex string', () => {
      assert.equal(typeof STALE_DATE_FOLD_COLOR, 'string');
      assert.match(STALE_DATE_FOLD_COLOR, /^#[0-9a-fA-F]{6}$/);
    });
  });

  describe('pickTagColor', () => {
    it('returns existing color without change', () => {
      assert.equal(pickTagColor('tag', { tag: '#abcdef' }), '#abcdef');
    });

    it('picks the first palette color when no tags have colors yet', () => {
      assert.equal(pickTagColor('new', {}), TAG_PALETTE[0]);
    });

    it('picks a different palette color for each new tag in sequence', () => {
      let colors: Record<string, string> = {};
      const c1 = pickTagColor('a', colors);
      colors = { ...colors, a: c1 };
      const c2 = pickTagColor('b', colors);
      colors = { ...colors, b: c2 };
      const c3 = pickTagColor('c', colors);
      assert.notEqual(c1, c2, 'second tag must differ from first');
      assert.notEqual(c2, c3, 'third tag must differ from second');
      assert.notEqual(c1, c3, 'first and third must differ');
      assert.deepEqual(
        [c1, c2, c3],
        TAG_PALETTE.slice(0, 3),
        'round-robin should follow palette order'
      );
    });

    it('wraps back to the first palette color after TAG_PALETTE.length assignments', () => {
      let colors: Record<string, string> = {};
      for (let i = 0; i < TAG_PALETTE.length; i += 1) {
        const c = pickTagColor(`t${i}`, colors);
        colors = { ...colors, [`t${i}`]: c };
      }
      const wrapped = pickTagColor('wrap', colors);
      assert.equal(wrapped, TAG_PALETTE[0]);
    });
  });

  describe('readableTextOn', () => {
    it('returns white on dark backgrounds', () => {
      assert.equal(readableTextOn('#000000'), '#ffffff');
    });

    it('returns dark text on light backgrounds', () => {
      assert.equal(readableTextOn('#ffffff'), '#1f2937');
    });
  });

  describe('tagShapeSx', () => {
    it('produces a non-empty style object for every declared shape', () => {
      for (const shape of TAG_SHAPES) {
        const sx = tagShapeSx(shape);
        assert.ok(sx, `${shape} must produce an sx object`);
        assert.ok(Object.keys(sx).length > 0, `${shape} must set at least one style`);
      }
    });

    it('declares box padding for every pointed shape', () => {
      const pointed: string[] = ['tag', 'flag', 'bookmark', 'hexagon', 'shield'];
      for (const shape of pointed) {
        const padding = tagShapeBoxPadding(shape as keyof typeof tagShapeSx);
        assert.ok(
          Object.keys(padding).length > 0,
          `${shape} pointed shape needs box padding`
        );
      }
    });

    it('returns no extra box padding for smooth shapes', () => {
      assert.deepEqual(tagShapeBoxPadding('rounded'), {});
      assert.deepEqual(tagShapeBoxPadding('square'), {});
    });
  });
});
