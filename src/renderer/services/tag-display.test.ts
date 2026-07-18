import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TFunction } from 'i18next';
import { geoTagDisplayLabel, tagDisplayLabel, chipSx, outlinedTagChipSx } from './tag-display';
import { TAG_SHAPES } from '../domain/tag-colors';

/**
 * The label helpers don't need a real i18next instance: each one returns the
 * key plus a structured rendering of its interpolation values, which is
 * stable enough to assert on without bootstrapping the i18n stack.
 *
 *   t('ratingStars', { count: 3 }) → 'ratingStars|3'
 *   t('smartTagToday')              → 'smartTagToday'
 *   t('tagCloudGeoLabel', { coords: '36.1,117.8' }) → 'tagCloudGeoLabel|36.1,117.8'
 */
function makeT(): TFunction {
  return ((key: string, opts?: Record<string, unknown>): string => {
    if (!opts) return key;
    // Sort keys for stable assertion strings.
    const parts = Object.keys(opts)
      .sort()
      .map((k) => `${k}=${String(opts[k])}`);
    return `${key}|${parts.join('&')}`;
  }) as unknown as TFunction;
}

describe('tagDisplayLabel', () => {
  const t = makeT();

  // 2026-07-04 (Sat) is the test reference date — used as `now` so all
  // date-family tags resolve to a stable, non-flaky value.
  const now = new Date(2026, 6, 4, 12, 0, 0, 0); // 2026-07-04 12:00 local
  // For `now` minute-precision tests we use the same wall-clock date.
  const nowNow = new Date(2026, 6, 4, 14, 30, 0, 0); // 2026-07-04 14:30

  it('returns localized ratingStars for ratings', () => {
    assert.equal(tagDisplayLabel('1star', t, now), 'ratingStars|count=1');
    assert.equal(tagDisplayLabel('5star', t, now), 'ratingStars|count=5');
  });

  it('returns localized workflow status for workflow values', () => {
    assert.equal(tagDisplayLabel('in-progress', t, now), 'smartTagWorkflowInProgress');
    assert.equal(tagDisplayLabel('completed', t, now), 'smartTagWorkflowCompleted');
  });

  it('returns localized quadrant for priority values', () => {
    assert.equal(tagDisplayLabel('urgent-important', t, now), 'smartTagQuadrantUrgentImportant');
  });

  it('returns localized date label for today/yesterday/tomorrow — legacy prefix form', () => {
    // Legacy form still supported for backward compat (Phase 4 migration rewrites them).
    assert.equal(tagDisplayLabel('today-20260704', t, now), 'smartTagToday');
    assert.equal(tagDisplayLabel('yesterday-20260703', t, now), 'smartTagYesterday');
    assert.equal(tagDisplayLabel('tomorrow-20260705', t, now), 'smartTagTomorrow');
  });

  it('returns localized date label for today/yesterday/tomorrow — new bare form (§1)', () => {
    assert.equal(tagDisplayLabel('20260704', t, now), 'smartTagToday');
    assert.equal(tagDisplayLabel('20260703', t, now), 'smartTagYesterday');
    assert.equal(tagDisplayLabel('20260705', t, now), 'smartTagTomorrow');
  });

  it('renders active `now` as a `YYYY-MM-DD HH:MM` timestamp string (§7)', () => {
    // Bare form, fresh within the same minute
    assert.equal(
      tagDisplayLabel('20260704T1430', t, nowNow),
      '2026-07-04 14:30'
    );
    // Legacy form, fresh within the same minute
    assert.equal(
      tagDisplayLabel('now-20260704T1430', t, nowNow),
      '2026-07-04 14:30'
    );
  });

  it('returns localized date label for nextWeek when stored equals nextWeek(now)', () => {
    // 2026-07-04 (Sat) → nextWeek = 2026-07-06 (Mon)
    assert.equal(tagDisplayLabel('20260706', t, now), 'smartTagNextWeek');
    // Legacy form
    assert.equal(tagDisplayLabel('week-20260706', t, now), 'smartTagNextWeek');
  });

  it('returns localized date label for currentMonth / currentYear — both forms', () => {
    assert.equal(tagDisplayLabel('202607', t, now), 'smartTagCurrentMonth');
    assert.equal(tagDisplayLabel('month-202607', t, now), 'smartTagCurrentMonth');
    assert.equal(tagDisplayLabel('2026', t, now), 'smartTagCurrentYear');
    assert.equal(tagDisplayLabel('year-2026', t, now), 'smartTagCurrentYear');
  });

  it('returns the raw tag for plain user/library tags', () => {
    assert.equal(tagDisplayLabel('vacation', t, now), 'vacation');
    assert.equal(tagDisplayLabel('idea', t, now), 'idea');
  });

  it('falls through to the raw tag for date-shaped values that are NOT fresh (§3 stale)', () => {
    // Stored as today on 2025-12-23; on 2026-07-04 it's stale → raw fall-through
    assert.equal(tagDisplayLabel('today-20251223', t, now), 'today-20251223');
    // Same idea with bare form
    assert.equal(tagDisplayLabel('20251223', t, now), '20251223');
    // Stale month / year / now / nextWeek
    assert.equal(tagDisplayLabel('month-202512', t, now), 'month-202512');
    assert.equal(tagDisplayLabel('year-2025', t, now), 'year-2025');
    assert.equal(tagDisplayLabel('now-20251223T1430', t, now), 'now-20251223T1430');
    assert.equal(tagDisplayLabel('20251223T1430', t, now), '20251223T1430');
    assert.equal(tagDisplayLabel('week-20251222', t, now), 'week-20251222');
  });

  it('default `now` parameter is `new Date()` — does not throw and produces reasonable output', () => {
    // Sanity: omitting `now` should not throw. The exact output depends on
    // the wall clock at test time, so we just assert it's a non-empty string.
    const label = tagDisplayLabel('1star', t);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0);
  });

  it('does NOT special-case geo tags — they stay raw here so chips can render an icon', () => {
    // The chip renderer overrides the geo label visually; this helper only
    // handles text-only surfaces. geoTagDisplayLabel is the entry point for
    // those (see below).
    assert.equal(tagDisplayLabel('geo:36.1,117.8', t, now), 'geo:36.1,117.8');
  });

  it('does NOT mistake look-alikes for smart date tags', () => {
    // SmartFunctionalityOfTag is STRICT — `month-report` matches no prefix and
    // returns null. Falling through is the right call so the cloud can still
    // show the user's actual text.
    assert.equal(tagDisplayLabel('month-report', t, now), 'month-report');
    assert.equal(tagDisplayLabel('year-end', t, now), 'year-end');
  });

  it('renders period tags as a compact `YYYY-MM-DD – YYYY-MM-DD` range via i18n', () => {
    // Phase 2 §5: period tags render via the `tagPeriodRange` template
    // (independent family from smart dates, not subject to freshness).
    assert.equal(
      tagDisplayLabel('20260701-20260703', t, now),
      'tagPeriodRange|end=2026-07-03&start=2026-07-01'
    );
    // Reverse-order input normalizes via dateTagRangeKey (start <= end).
    assert.equal(
      tagDisplayLabel('20260710-20260701', t, now),
      'tagPeriodRange|end=2026-07-10&start=2026-07-01'
    );
  });
});

describe('geoTagDisplayLabel', () => {
  const t = makeT();

  it('returns null for non-geo tags so callers can chain with tagDisplayLabel', () => {
    assert.equal(geoTagDisplayLabel('work', t), null);
    assert.equal(geoTagDisplayLabel('vacation', t), null);
    assert.equal(geoTagDisplayLabel('3star', t), null);
    assert.equal(geoTagDisplayLabel('', t), null);
  });

  it('returns the i18n key + coordinates for valid geo:lat,lng tags (P0-1)', () => {
    assert.equal(
      geoTagDisplayLabel('geo:36.1,117.8', t),
      'tagCloudGeoLabel|coords=36.1,117.8'
    );
    assert.equal(
      geoTagDisplayLabel('geo:-33.8688,151.2093', t),
      'tagCloudGeoLabel|coords=-33.8688,151.2093'
    );
  });

  it('strips only the `geo:` prefix, preserving inner whitespace', () => {
    // isGeoTag tolerates whitespace around the comma (see GEO_TAG_RE in
    // geo-tag.ts); the slice hands those through to the i18n string verbatim.
    assert.equal(
      geoTagDisplayLabel('geo:36.1 , 117.8', t),
      'tagCloudGeoLabel|coords=36.1 , 117.8'
    );
  });

  it('rejects malformed geo tags by returning null', () => {
    assert.equal(geoTagDisplayLabel('geo:abc,def', t), null);
    assert.equal(geoTagDisplayLabel('geo:36.1', t), null); // missing lng
    assert.equal(geoTagDisplayLabel('geo:', t), null);
    assert.equal(geoTagDisplayLabel('36.1,117.8', t), null); // no prefix
  });

  it('chains naturally with tagDisplayLabel via `??`', () => {
    // The intended caller pattern (TagCloudView):
    //     geoTagDisplayLabel(raw, t) ?? tagDisplayLabel(raw, t)
    // — geo gets the emoji label, plain tags get the raw value, ratings keep
    // their ratingStars localization.
    //
    // Pin `now` to 2026-07-04 so the today/yesterday/tomorrow fixtures are
    // fresh at composition time. Without this, the default `new Date()` could
    // make them stale and the assertion would race.
    const now = new Date(2026, 6, 4, 12, 0, 0, 0);
    const label = (raw: string) =>
      geoTagDisplayLabel(raw, t) ?? tagDisplayLabel(raw, t, now);
    assert.equal(label('geo:36.1,117.8'), 'tagCloudGeoLabel|coords=36.1,117.8');
    assert.equal(label('vacation'), 'vacation');
    assert.equal(label('3star'), 'ratingStars|count=3');
    assert.equal(label('today-20260704'), 'smartTagToday');
  });
});

describe('chipSx', () => {
  it('keeps the compact base size for every tag shape', () => {
    for (const shape of TAG_SHAPES) {
      const sx = chipSx('#3b82f6', false, shape) as Record<string, unknown>;
      assert.equal(sx.height, 20, `${shape} chip height must stay 20`);
      assert.equal(sx.fontSize, 11, `${shape} chip fontSize must stay 11`);
    }
  });

  it('keeps the compact base size for active chips of every shape', () => {
    for (const shape of TAG_SHAPES) {
      const sx = chipSx('#3b82f6', true, shape) as Record<string, unknown>;
      assert.equal(sx.height, 20, `${shape} active chip height must stay 20`);
      assert.equal(sx.fontSize, 11, `${shape} active chip fontSize must stay 11`);
    }
  });
});

describe('outlinedTagChipSx', () => {
  it('keeps the compact base size for every tag shape', () => {
    for (const shape of TAG_SHAPES) {
      const sx = outlinedTagChipSx('#3b82f6', shape) as Record<string, unknown>;
      assert.equal(sx.height, 20, `${shape} outlined chip height must stay 20`);
      assert.equal(sx.fontSize, 11, `${shape} outlined chip fontSize must stay 11`);
    }
  });
});