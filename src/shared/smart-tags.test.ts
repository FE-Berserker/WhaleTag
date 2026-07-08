import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnyDateShapeTag,
  isPeriodTag,
  isSmartDateTag,
  isSmartFunctionalityName,
  isStaleDateTag,
  mondayOfWeek,
  normalizeSmartTags,
  PERIOD_COLOR,
  resolveInputTag,
  resolveSmartTag,
  smartFunctionalityOfTag,
  withSingleDateTag,
  withSinglePeriodTag,
} from './smart-tags';

/** Local date with no time-of-day component (avoid TZ drift in assertions). */
function localDate(yyyy: number, mm: number, dd: number): Date {
  return new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
}

/**
 * Build a Date with arbitrary local time-of-day (for `now` precision tests).
 */
function localDateTime(
  yyyy: number,
  mm: number,
  dd: number,
  hh: number,
  mi: number
): Date {
  return new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
}

describe('mondayOfWeek', () => {
  it('returns the same date when input is a Monday', () => {
    const mon = localDate(2026, 7, 6); // 2026-07-06 is a Monday
    const out = mondayOfWeek(mon);
    assert.equal(out.getFullYear(), 2026);
    assert.equal(out.getMonth() + 1, 7);
    assert.equal(out.getDate(), 6);
  });

  it('returns the prior Monday for a Wednesday', () => {
    const wed = localDate(2026, 7, 8); // Wednesday
    const out = mondayOfWeek(wed);
    assert.equal(out.getDate(), 6); // Monday is 2 days back
  });

  it('returns the prior Monday for a Sunday', () => {
    const sun = localDate(2026, 7, 12); // Sunday
    const out = mondayOfWeek(sun);
    assert.equal(out.getDate(), 6); // Sunday → Monday of *this* week is 6 days back
  });

  it('returns the same Monday for Tuesday–Sunday of the same week', () => {
    const mon = mondayOfWeek(localDate(2026, 7, 6));
    for (let d = 6; d <= 12; d += 1) {
      const day = localDate(2026, 7, d);
      const out = mondayOfWeek(day);
      assert.equal(out.getDate(), mon.getDate(), `weekday ${d}`);
    }
  });
});

// All 2026-07-04* tests in this file use 2026-07-04 (Sat) as `now`, so the
// active-tag values resolve to the *new* compact form (no prefix).
const TODAY = localDate(2026, 7, 4); // Saturday 2026-07-04 12:00 local
const TOMORROW = localDate(2026, 7, 5); // Sunday
const MON_AFTER = localDate(2026, 7, 6); // Monday 2026-07-06
const NEXT_MON = localDate(2026, 7, 13); // Following Monday (nextWeek from Saturday)

describe('resolveSmartTag returns bare compact values (post §1 migration)', () => {
  it('today returns YYYYMMDD', () => {
    assert.equal(resolveSmartTag('today', TODAY), '20260704');
  });
  it('yesterday returns YYYYMMDD', () => {
    assert.equal(resolveSmartTag('yesterday', TODAY), '20260703');
  });
  it('tomorrow returns YYYYMMDD', () => {
    assert.equal(resolveSmartTag('tomorrow', TODAY), '20260705');
  });
  it('now returns YYYYMMDDTHHMM', () => {
    const now = localDateTime(2026, 7, 4, 14, 30);
    assert.equal(resolveSmartTag('now', now), '20260704T1430');
  });
  it('currentMonth returns YYYYMM', () => {
    assert.equal(resolveSmartTag('currentMonth', TODAY), '202607');
  });
  it('currentYear returns YYYY', () => {
    assert.equal(resolveSmartTag('currentYear', TODAY), '2026');
  });
  it('nextWeek returns YYYYMMDD (Monday of next week)', () => {
    // 2026-07-04 (Sat) → +7 → 2026-07-11 (Sat) → mondayOfWeek → 2026-07-06 (Mon)
    assert.equal(resolveSmartTag('nextWeek', TODAY), '20260706');
    // 2026-07-05 (Sun) → same → 2026-07-06
    assert.equal(resolveSmartTag('nextWeek', TOMORROW), '20260706');
    // 2026-07-06 (Mon) → +7 → 2026-07-13 (Mon) → snap → 2026-07-13
    assert.equal(resolveSmartTag('nextWeek', MON_AFTER), '20260713');
  });
  it('workflow resolves to its stored token', () => {
    assert.equal(resolveSmartTag('workflowInProgress', TODAY), 'in-progress');
    assert.equal(resolveSmartTag('workflowCompleted', TODAY), 'completed');
  });
  it('quadrant resolves to its stored token', () => {
    assert.equal(
      resolveSmartTag('quadrantUrgentImportant', TODAY),
      'urgent-important'
    );
  });
  it('rating resolves to <n>star', () => {
    assert.equal(resolveSmartTag('star3', TODAY), '3star');
    assert.equal(resolveSmartTag('star5', TODAY), '5star');
  });
});

describe('smartFunctionalityOfTag — fresh tags (§3 freshness window)', () => {
  it('bare today matches at the same calendar date', () => {
    assert.equal(smartFunctionalityOfTag('20260704', TODAY), 'today');
  });
  it('bare yesterday matches when now is the day after', () => {
    assert.equal(smartFunctionalityOfTag('20260703', TODAY), 'yesterday');
    // Above: on 07-05 (TOMORROW), 20260703 is two days ago → null
    assert.equal(smartFunctionalityOfTag('20260703', TOMORROW), null);
  });
  it('bare tomorrow matches when now is the day before', () => {
    assert.equal(smartFunctionalityOfTag('20260705', TODAY), 'tomorrow');
  });
  it('bare nextWeek matches when stored value equals resolveSmartTag(now)', () => {
    // On Saturday 2026-07-04: nextWeek resolves to 20260706 (Monday)
    assert.equal(smartFunctionalityOfTag('20260706', TODAY), 'nextWeek');
    // On Sunday 2026-07-05: both `tomorrow` AND `nextWeek` resolve to 2026-07-06.
    // The functionality loop matches `tomorrow` first (declaration order).
    assert.equal(smartFunctionalityOfTag('20260706', TOMORROW), 'tomorrow');
    // On Monday 2026-07-06: 07-06 is "today", not next-week
    assert.equal(smartFunctionalityOfTag('20260706', MON_AFTER), 'today');
    assert.equal(smartFunctionalityOfTag('20260713', MON_AFTER), 'nextWeek');
  });
  it('bare now matches within the same minute window', () => {
    const base = localDateTime(2026, 7, 4, 14, 30);
    assert.equal(smartFunctionalityOfTag('20260704T1430', base), 'now');
    // 1 ms later — still same minute
    const later = new Date(base.getTime() + 1);
    assert.equal(smartFunctionalityOfTag('20260704T1430', later), 'now');
    // Different time-of-day
    assert.equal(
      smartFunctionalityOfTag('20260704T1430', localDateTime(2026, 7, 4, 14, 31)),
      null
    );
    // Different day
    assert.equal(
      smartFunctionalityOfTag('20260704T1430', localDateTime(2026, 7, 5, 14, 30)),
      null
    );
  });
  it('bare currentMonth matches same month', () => {
    assert.equal(smartFunctionalityOfTag('202607', TODAY), 'currentMonth');
    // Different month — 2026-07 was currentMonth on July, but on August 1 it's stale
    assert.equal(smartFunctionalityOfTag('202607', localDate(2026, 8, 1)), null);
    assert.equal(smartFunctionalityOfTag('202608', localDate(2026, 8, 1)), 'currentMonth');
  });
  it('bare currentYear matches same year', () => {
    assert.equal(smartFunctionalityOfTag('2026', TODAY), 'currentYear');
    assert.equal(smartFunctionalityOfTag('2026', localDate(2027, 1, 1)), null);
    assert.equal(smartFunctionalityOfTag('2027', localDate(2027, 1, 1)), 'currentYear');
  });
});

describe('smartFunctionalityOfTag — stale tags return null (§3)', () => {
  it('legacy today- prefix becomes stale when now is later', () => {
    // Tagged on 2025-12-23, queried on 2026-07-04 → stale
    assert.equal(smartFunctionalityOfTag('today-20251223', TODAY), null);
    // Same date as now → still fresh (legacy compat)
    assert.equal(smartFunctionalityOfTag('today-20260704', TODAY), 'today');
  });
  it('legacy yesterday- prefix becomes stale', () => {
    assert.equal(smartFunctionalityOfTag('yesterday-20251222', TODAY), null);
    assert.equal(smartFunctionalityOfTag('yesterday-20260703', TODAY), 'yesterday');
  });
  it('legacy tomorrow- prefix becomes stale', () => {
    assert.equal(smartFunctionalityOfTag('tomorrow-20251224', TODAY), null);
    assert.equal(smartFunctionalityOfTag('tomorrow-20260705', TODAY), 'tomorrow');
  });
  it('legacy week- prefix becomes stale after the Monday passes', () => {
    assert.equal(smartFunctionalityOfTag('week-20251222', TODAY), null);
    assert.equal(smartFunctionalityOfTag('week-20260706', TODAY), 'nextWeek');
    // On 2026-07-06 itself, 07-06 = "today" (loop hits `today` before nextWeek)
    assert.equal(smartFunctionalityOfTag('week-20260706', MON_AFTER), 'today');
  });
  it('legacy month- prefix becomes stale next month', () => {
    assert.equal(smartFunctionalityOfTag('month-202512', TODAY), null);
    assert.equal(smartFunctionalityOfTag('month-202607', TODAY), 'currentMonth');
  });
  it('legacy year- prefix becomes stale next year', () => {
    assert.equal(smartFunctionalityOfTag('year-2025', TODAY), null);
    assert.equal(smartFunctionalityOfTag('year-2026', TODAY), 'currentYear');
  });
  it('legacy now- prefix becomes stale after a few minutes / day', () => {
    const stored = 'now-20251223T1430';
    assert.equal(smartFunctionalityOfTag(stored, TODAY), null);
    assert.equal(smartFunctionalityOfTag('now-20260704T1200', TODAY), 'now');
  });
});

describe('smartFunctionalityOfTag — cross-day boundary 23:59→00:00', () => {
  it('today resolves fresh across the local-midnight boundary when stored equals new today', () => {
    // 23:59:59.999 on day X → 00:00:00.000 on day X+1; a tag stored as day-X+1
    // becomes active at the boundary.
    const t2359 = localDateTime(2026, 7, 4, 23, 59);
    const t0000 = localDateTime(2026, 7, 5, 0, 0);
    assert.equal(smartFunctionalityOfTag('20260704', t2359), 'today');
    assert.equal(smartFunctionalityOfTag('20260704', t0000), 'yesterday');
    assert.equal(smartFunctionalityOfTag('20260705', t0000), 'today');
  });
});

describe('smartFunctionalityOfTag — guards against look-alikes', () => {
  it('does not mistake plain 8-digit strings for smart tags', () => {
    assert.equal(smartFunctionalityOfTag('12345678', TODAY), null);
  });
  it('does not mistake month-report / year-end for smart tags', () => {
    assert.equal(smartFunctionalityOfTag('month-report', TODAY), null);
    assert.equal(smartFunctionalityOfTag('year-end', TODAY), null);
  });
  it('does not flag period tags as a smart functionality', () => {
    assert.equal(smartFunctionalityOfTag('20260704-20260710', TODAY), null);
  });
  it('does not flag 6-digit month-shaped strings for currentMonth when year differs', () => {
    assert.equal(smartFunctionalityOfTag('209907', TODAY), null); // wrong year/month; still currentMonth would only match 'current month' resolution
    // actually no, '209907' is 2099-07 — not the same as currentMonth 202607 → null
  });
});

describe('smartFunctionalityOfTag — time-independent families (§3 invariant)', () => {
  it('rating and workflow unaffected by `now`', () => {
    const future = localDate(2099, 1, 1);
    assert.equal(smartFunctionalityOfTag('3star', TODAY), 'star3');
    assert.equal(smartFunctionalityOfTag('3star', future), 'star3');
    assert.equal(smartFunctionalityOfTag('in-progress', TODAY), 'workflowInProgress');
    assert.equal(smartFunctionalityOfTag('in-progress', future), 'workflowInProgress');
    assert.equal(
      smartFunctionalityOfTag('urgent-important', TODAY),
      'quadrantUrgentImportant'
    );
  });
  it('default `now` parameter (no-arg call) is `new Date()` — does not throw', () => {
    // Sanity: omitting `now` still parses & returns; no TypeError.
    const r = smartFunctionalityOfTag('idea'); // not a smart tag
    assert.equal(r, null);
  });
});

describe('PERIOD_COLOR', () => {
  it('is exported and is a non-empty hex string', () => {
    assert.equal(typeof PERIOD_COLOR, 'string');
    assert.match(PERIOD_COLOR, /^#[0-9a-fA-F]{6}$/);
  });
});

describe('isPeriodTag', () => {
  it('accepts YYYYMMDD-YYYYMMDD with strict format', () => {
    assert.equal(isPeriodTag('20260701-20260703'), true);
  });
  it('accepts reversed input (dateTagRangeKey normalizes)', () => {
    assert.equal(isPeriodTag('20260710-20260701'), true);
  });
  it('rejects single-day tags', () => {
    assert.equal(isPeriodTag('20260704'), false);
    assert.equal(isPeriodTag('today-20260704'), false);
  });
  it('rejects non-date-shape strings', () => {
    assert.equal(isPeriodTag('idea'), false);
    assert.equal(isPeriodTag('work'), false);
    assert.equal(isPeriodTag('20260701-2026070'), false); // too short
    assert.equal(isPeriodTag('2026-07-01'), false); // dashed, wrong shape
  });
  it('rejects malformed components', () => {
    assert.equal(isPeriodTag('20261301-20260730'), false); // month 13
    assert.equal(isPeriodTag('20260631-20260700'), false); // day out of range
  });
});

describe('isSmartDateTag', () => {
  it('returns true for an active smart date tag (bare or legacy prefix)', () => {
    assert.equal(isSmartDateTag('20260704', TODAY), true);
    assert.equal(isSmartDateTag('today-20260704', TODAY), true);
    assert.equal(isSmartDateTag('month-202607', TODAY), true);
    assert.equal(isSmartDateTag('week-20260706', TODAY), true);
    assert.equal(isSmartDateTag('now-20260704T1200', TODAY), true);
  });
  it('returns false for a stale smart date tag', () => {
    assert.equal(isSmartDateTag('20251223', TODAY), false);
    assert.equal(isSmartDateTag('today-20251223', TODAY), false);
  });
  it('returns false for non-date tags', () => {
    assert.equal(isSmartDateTag('idea', TODAY), false);
    assert.equal(isSmartDateTag('3star', TODAY), false);
    assert.equal(isSmartDateTag('in-progress', TODAY), false);
  });
  it('returns false for period tags (period is a separate family)', () => {
    assert.equal(isSmartDateTag('20260701-20260703', TODAY), false);
  });
});

describe('withSingleDateTag — date family exclusivity (covers active + stale)', () => {
  it('last wins when multiple active smart date tags exist', () => {
    // On 2026-07-04, `today-20260704` and `month-202607` are both active
    const tags = ['today-20260704', 'month-202607', 'idea'];
    const out = withSingleDateTag(tags, TODAY);
    assert.deepEqual(out, ['month-202607', 'idea']);
  });
  it('互斥 across active + stale: an active today and a stale month collapse to one', () => {
    // Files migrated from Phase 4 may carry a mix: `today-20260704` (active)
    // and `month-202606` (stale). The互斥 covers both — only the last-
    // applied date-shaped tag stays. This is the post-2026-07-04 spec
    // change: previously stale date tags passed through, leading to the
    // "active + stale coexist" UX bug.
    const tags = ['idea', 'today-20260704', 'month-202606'];
    const out = withSingleDateTag(tags, TODAY);
    assert.deepEqual(out, ['idea', 'month-202606']);
  });
  it('互斥 across multiple stale date tags: keeps last', () => {
    // Two stale tags, both fail `isSmartDateTag`, but互斥 still applies
    // because `isAnyDateShapeTag` is broad.
    const tags = ['idea', 'today-20251223', 'month-202512'];
    const out = withSingleDateTag(tags, TODAY);
    assert.deepEqual(out, ['idea', 'month-202512']);
  });
  it('does not affect period / rating / workflow / quadrant tags', () => {
    const tags = [
      '20260701-20260703', // period
      '3star', // rating
      'in-progress', // workflow
      'urgent-important', // quadrant
      'idea', // plain
    ];
    const out = withSingleDateTag(tags, TODAY);
    assert.deepEqual(out, tags);
  });
});

describe('withSinglePeriodTag — period family exclusivity', () => {
  it('keeps the last period tag, drops earlier ones', () => {
    const tags = ['20260701-20260703', 'idea', '20260710-20260720'];
    const out = withSinglePeriodTag(tags);
    assert.deepEqual(out, ['idea', '20260710-20260720']);
  });
  it('leaves a single-period list intact', () => {
    const tags = ['20260701-20260703', 'idea', '3star'];
    assert.deepEqual(withSinglePeriodTag(tags), tags);
  });
  it('does not affect date smart tags', () => {
    const tags = ['today-20260704', 'month-202607', 'idea'];
    assert.deepEqual(withSinglePeriodTag(tags), tags);
  });
});

describe('normalizeSmartTags — combined exclusivity chain', () => {
  it('applies all five families in one pass (with today pinned to 2026-07-04)', () => {
    // Pin `now` via a private re-implementation since `normalizeSmartTags`
    // uses default `new Date()`. We rely on the test's wall clock being
    // 2026-07-04 (the active test date for Phase 1/2). For the date family
    // `today-20260704` is active and `month-202607` is active; both go
    // through the withSingleDateTag step (last-wins → month kept).
    const tags = [
      '1star', '5star', 'idea', // rating
      'in-progress', 'completed', 'idea', // workflow
      'urgent-important', 'noturgent-unimportant', // quadrant
      'today-20260704', 'month-202607', // date (last active → month kept)
      '20260701-20260703', '20260710-20260720', // period (last → 07-10..07-20)
      'idea',
    ];
    const out = normalizeSmartTags(tags);
    assert.deepEqual(out, [
      '5star', // rating: last wins (1star dropped)
      'idea', // plain, kept
      'completed', // workflow: last wins (in-progress dropped)
      'idea', // plain, kept
      'noturgent-unimportant', // quadrant: last wins (urgent-important dropped)
      'month-202607', // date: last wins (today-20260704 active but earlier in the input)
      '20260710-20260720', // period: last wins
      'idea', // plain, kept
    ]);
  });
  it('period and date families are independent — coexist', () => {
    // Both active on the test reference date.
    const tags = [
      'today-20260704',
      '20260701-20260703',
      'idea',
    ];
    const out = normalizeSmartTags(tags);
    assert.deepEqual(out, ['today-20260704', '20260701-20260703', 'idea']);
  });
  it('cross-family isolation: stale date tag + active period tag', () => {
    // Stale date tag falls outside the active family → unaffected by
    // withSingleDateTag. Period still goes through withSinglePeriodTag.
    const tags = ['today-20251223', '20260701-20260703', 'idea'];
    const out = normalizeSmartTags(tags);
    assert.deepEqual(out, ['today-20251223', '20260701-20260703', 'idea']);
  });
});

describe('isStaleDateTag — Phase 3 stale-date fold predicate', () => {
  it('returns true for any of the 7 stale date shapes (with or without legacy prefix)', () => {
    // All shapes (day / month / year / datetime) with old prefix, queried on
    // TODAY=2026-07-04 — every stored value is from the past and therefore stale.
    assert.equal(isStaleDateTag('today-20251223', TODAY), true);
    assert.equal(isStaleDateTag('yesterday-20251222', TODAY), true);
    assert.equal(isStaleDateTag('tomorrow-20251224', TODAY), true);
    assert.equal(isStaleDateTag('week-20251222', TODAY), true);
    assert.equal(isStaleDateTag('month-202512', TODAY), true);
    assert.equal(isStaleDateTag('year-2025', TODAY), true);
    assert.equal(isStaleDateTag('now-20251223T1430', TODAY), true);
    // Bare form
    assert.equal(isStaleDateTag('20251223', TODAY), true);
    assert.equal(isStaleDateTag('202512', TODAY), true);
    assert.equal(isStaleDateTag('2025', TODAY), true);
    assert.equal(isStaleDateTag('20251223T1430', TODAY), true);
  });
  it('returns false for ACTIVE date tags (within freshness window)', () => {
    assert.equal(isStaleDateTag('today-20260704', TODAY), false);
    assert.equal(isStaleDateTag('month-202607', TODAY), false);
    assert.equal(isStaleDateTag('year-2026', TODAY), false);
    assert.equal(isStaleDateTag('20260704', TODAY), false);
    assert.equal(isStaleDateTag('20260704T1200', localDateTime(2026, 7, 4, 12, 0)), false);
  });
  it('excludes period tags — they have their own fold (period:)', () => {
    // Even a "stale" period (whatever that means) doesn't go to date:
    assert.equal(isStaleDateTag('20260701-20260703', TODAY), false);
    assert.equal(isStaleDateTag('20251201-20251210', TODAY), false);
  });
  it('returns false for non-date tags', () => {
    assert.equal(isStaleDateTag('idea', TODAY), false);
    assert.equal(isStaleDateTag('3star', TODAY), false);
    assert.equal(isStaleDateTag('in-progress', TODAY), false);
    assert.equal(isStaleDateTag('urgent-important', TODAY), false);
    assert.equal(isStaleDateTag('geo:36.1,117.8', TODAY), false);
  });
  it('returns false for non-date-shape strings (rejected by normalizeDateTag)', () => {
    // These don't match the digit-count pattern (8 / 6 / 4 / 8+T) so they're
    // not date-shape at all — they pass through to the regular tag branch in
    // TagMetaContextProvider (counted as plain tags, NOT under "date:").
    assert.equal(isStaleDateTag('id-2026-123', TODAY), false);
    assert.equal(isStaleDateTag('report-2026', TODAY), false);
    assert.equal(isStaleDateTag('year-end', TODAY), false);
    assert.equal(isStaleDateTag('month-report', TODAY), false);
    assert.equal(isStaleDateTag('', TODAY), false);
  });
  it('captures 8-digit numbers that match shape but are not a real active date', () => {
    // Even a malformed date like 20261301 (month 13) is shape-valid: 8 digits,
    // not currently active → counted as stale. This is intentional — the `日期`
    // fold chip aggregates ALL stale date-shaped tags; downstream callers
    // (calendar) can validate the value itself. Test the shape rule, not
    // dateTagDayKey validity.
    assert.equal(isStaleDateTag('20261301', TODAY), true);
    assert.equal(isStaleDateTag('20260631', TODAY), true); // June 31 — invalid day
  });
  it('default `now` parameter is `new Date()` — does not throw', () => {
    assert.equal(typeof isStaleDateTag('today-20251223'), 'boolean');
  });
});

describe('isSmartFunctionalityName — Phase 5 addTag input predicate', () => {
  it('recognizes the 7 date template names', () => {
    for (const t of ['today', 'yesterday', 'tomorrow', 'now', 'nextWeek', 'currentMonth', 'currentYear']) {
      assert.equal(isSmartFunctionalityName(t), true, `${t} should be smart`);
    }
  });
  it('recognizes the 5 rating template names', () => {
    for (const t of ['star1', 'star2', 'star3', 'star4', 'star5']) {
      assert.equal(isSmartFunctionalityName(t), true, `${t} should be smart`);
    }
  });
  it('recognizes the 5 workflow resolved tokens', () => {
    for (const t of ['not-started', 'in-progress', 'completed', 'abandoned', 'planned']) {
      assert.equal(isSmartFunctionalityName(t), true, `${t} should be smart`);
    }
  });
  it('recognizes the 4 quadrant resolved tokens', () => {
    for (const t of ['urgent-important', 'urgent-unimportant', 'noturgent-important', 'noturgent-unimportant']) {
      assert.equal(isSmartFunctionalityName(t), true, `${t} should be smart`);
    }
  });
  it('rejects plain user tags', () => {
    assert.equal(isSmartFunctionalityName('vacation'), false);
    assert.equal(isSmartFunctionalityName('idea'), false);
    assert.equal(isSmartFunctionalityName('work'), false);
  });
  it('rejects compact date forms (those are not template names)', () => {
    // '20260704' is the stored form, not a template name — the user can't
    // type the bare stored form in the input (autocomplete would suggest
    // a different path).  `resolveInputTag` handles these via the prefix
    // stripper, not this predicate.
    assert.equal(isSmartFunctionalityName('20260704'), false);
    assert.equal(isSmartFunctionalityName('202607'), false);
  });
  it('rejects prefix forms (those are not template names either)', () => {
    assert.equal(isSmartFunctionalityName('today-20260704'), false);
    assert.equal(isSmartFunctionalityName('month-202606'), false);
  });
});

describe('resolveInputTag — input → storage normalization', () => {
  it('resolves `today` to today\'s compact YYYYMMDD', () => {
    assert.equal(resolveInputTag('today', TODAY), '20260704');
  });
  it('resolves `tomorrow` to today + 1 day', () => {
    assert.equal(resolveInputTag('tomorrow', TODAY), '20260705');
  });
  it('resolves `yesterday` to today - 1 day', () => {
    assert.equal(resolveInputTag('yesterday', TODAY), '20260703');
  });
  it('resolves `now` to compact YYYYMMDDTHHMM', () => {
    assert.equal(resolveInputTag('now', TODAY), '20260704T1200');
  });
  it('resolves workflow tokens to themselves (already stored form)', () => {
    assert.equal(resolveInputTag('in-progress', TODAY), 'in-progress');
    assert.equal(resolveInputTag('completed', TODAY), 'completed');
  });
  it('resolves quadrant tokens to themselves', () => {
    assert.equal(resolveInputTag('urgent-important', TODAY), 'urgent-important');
  });
  it('strips legacy prefix form `month-202606` to compact `202606`', () => {
    assert.equal(resolveInputTag('month-202606', TODAY), '202606');
    assert.equal(resolveInputTag('today-20260704', TODAY), '20260704');
    assert.equal(resolveInputTag('now-20251223T1430', TODAY), '20251223T1430');
  });
  it('passes plain user tags through unchanged', () => {
    assert.equal(resolveInputTag('vacation', TODAY), 'vacation');
    assert.equal(resolveInputTag('idea', TODAY), 'idea');
  });
  it('passes already-compact date forms through unchanged', () => {
    assert.equal(resolveInputTag('20260704', TODAY), '20260704');
    assert.equal(resolveInputTag('202607', TODAY), '202607');
  });
  it('passes period tags through unchanged (period family is separate)', () => {
    assert.equal(resolveInputTag('20260701-20260703', TODAY), '20260701-20260703');
  });
});

describe('addTag-style互斥 after resolveInputTag — full chain', () => {
  it('typing `today` then `tomorrow` collapses to one date tag (互斥 works)', () => {
    // Simulate the addTag flow: resolve → check dup → apply互斥.
    // (This is what PropertiesTray.addTag now does.)
    const apply = (current: string[], input: string) => {
      const resolved = resolveInputTag(input, TODAY);
      if (current.includes(resolved)) return current;
      if (isAnyDateShapeTag(resolved)) {
        return withSingleDateTag([...current, resolved], TODAY);
      }
      return [...current, resolved];
    };
    let tags: string[] = [];
    tags = apply(tags, 'today');
    assert.deepEqual(tags, ['20260704']);
    tags = apply(tags, 'tomorrow');
    assert.deepEqual(tags, ['20260705'], 'tomorrow replaces today');
  });
  it('typing legacy `month-202606` then fresh `today` collapses to one', () => {
    const apply = (current: string[], input: string) => {
      const resolved = resolveInputTag(input, TODAY);
      if (current.includes(resolved)) return current;
      if (isAnyDateShapeTag(resolved)) {
        return withSingleDateTag([...current, resolved], TODAY);
      }
      return [...current, resolved];
    };
    let tags: string[] = [];
    tags = apply(tags, 'month-202606');
    assert.deepEqual(tags, ['202606']);
    tags = apply(tags, 'today');
    assert.deepEqual(tags, ['20260704'], 'today replaces the legacy month tag');
  });
  it('period tags are NOT互斥 by date互斥 (independent family)', () => {
    const tags = ['20260701-20260703']; // period
    const resolved = resolveInputTag('today', TODAY);
    if (isAnyDateShapeTag(resolved)) {
      // would互斥 with date, but period is NOT a date shape — so they coexist.
    }
    const next = withSingleDateTag([...tags, resolved], TODAY);
    // period stays, date互斥 applies within date family
    assert.deepEqual(next, ['20260701-20260703', '20260704']);
  });
});
