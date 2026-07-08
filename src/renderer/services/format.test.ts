import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TFunction } from 'i18next';

import { formatDate, formatSize, truncate } from './format';

/**
 * Build a TFunction stub that records every key + payload it was called with
 * and returns a predictable string. We don't need real i18n here — we just
 * need to assert which key was picked and which `count` was passed (so the
 * i18n key + plural branch can be verified).
 */
function makeT(): TFunction & { calls: Array<{ key: string; count?: number }> } {
  const calls: Array<{ key: string; count?: number }> = [];
  const t = ((key: string, opts?: { count?: number }) => {
    // Only record `count` when the caller actually passed one — otherwise the
    // "justNow" call (which never gets a count) would still appear as
    // `{ key, count: undefined }` and break deepEqual assertions.
    const entry: { key: string; count?: number } = { key };
    if (opts?.count !== undefined) entry.count = opts.count;
    calls.push(entry);
    // Echo a stable string back so callers (and assertions) can compare.
    return opts?.count !== undefined ? `${key}:${opts.count}` : key;
  }) as unknown as TFunction & {
    calls: Array<{ key: string; count?: number }>;
  };
  t.calls = calls;
  return t;
}

/** ISO string for `n` milliseconds before "right now". */
function ago(n: number): string {
  return new Date(Date.now() - n).toISOString();
}

describe('renderer format', () => {
  describe('formatSize', () => {
    it('formats bytes, KB, MB, GB', () => {
      assert.equal(formatSize(0), '');
      assert.equal(formatSize(512), '512 B');
      assert.equal(formatSize(1024), '1.0 KB');
      assert.equal(formatSize(1024 * 1024), '1.0 MB');
      assert.equal(formatSize(1024 * 1024 * 1024), '1.0 GB');
    });

    it('keeps one decimal place', () => {
      assert.equal(formatSize(1536), '1.5 KB');
      assert.equal(formatSize(1024 * 1024 * 1.5), '1.5 MB');
    });

    it('caps at TB', () => {
      // >1024 TB should not crash and should still report TB.
      const huge = 1024 ** 4 * 5;
      assert.ok(formatSize(huge).endsWith(' TB'));
    });
  });

  describe('truncate', () => {
    it('returns input unchanged when short enough', () => {
      assert.equal(truncate('abc', 5), 'abc');
    });

    it('appends ellipsis when too long', () => {
      assert.equal(truncate('abcdef', 4), 'abc…');
    });

    it('returns empty for non-positive max', () => {
      assert.equal(truncate('abc', 0), '');
      assert.equal(truncate('abc', -1), '');
    });
  });

  describe('formatDate', () => {
    describe('input guards', () => {
      it('returns empty for empty / missing iso', () => {
        assert.equal(formatDate(''), '');
      });

      it('returns empty for unparseable iso', () => {
        assert.equal(formatDate('not-a-date'), '');
      });
    });

    describe('absolute mode (default + explicit)', () => {
      it('uses toLocaleDateString by default', () => {
        // The exact string is locale-dependent; just check it is non-empty
        // and matches what `new Date(iso).toLocaleDateString()` returns.
        const iso = '2026-07-02T12:00:00Z';
        assert.equal(formatDate(iso), new Date(iso).toLocaleDateString());
      });

      it('uses toLocaleDateString when mode is "absolute"', () => {
        const iso = '2026-07-02T12:00:00Z';
        assert.equal(
          formatDate(iso, { mode: 'absolute' }),
          new Date(iso).toLocaleDateString()
        );
      });

      it('does not call t() in absolute mode', () => {
        const t = makeT();
        formatDate('2026-07-02T12:00:00Z', { mode: 'absolute', t });
        assert.equal(t.calls.length, 0);
      });
    });

    describe('relative mode — missing t() falls back to absolute', () => {
      it('renders an absolute date string when t is omitted', () => {
        const iso = ago(5 * 60_000); // 5 min ago
        // No `t` passed — should still produce a sensible date, not throw.
        const out = formatDate(iso, { mode: 'relative' });
        assert.equal(out, new Date(iso).toLocaleDateString());
      });

      it('falls back when t is explicitly undefined', () => {
        const iso = ago(5 * 60_000);
        const out = formatDate(iso, { mode: 'relative', t: undefined });
        assert.equal(out, new Date(iso).toLocaleDateString());
      });
    });

    describe('relative mode — bucket selection', () => {
      it('picks "justNow" for < 1 min', () => {
        const t = makeT();
        const out = formatDate(ago(30_000), { mode: 'relative', t });
        assert.equal(out, 'justNow');
        assert.deepEqual(t.calls, [{ key: 'justNow' }]);
      });

      it('picks "nMinutesAgo" for 1..59 min and passes count', () => {
        const t = makeT();
        const out = formatDate(ago(5 * 60_000), { mode: 'relative', t });
        assert.equal(out, 'nMinutesAgo:5');
        assert.deepEqual(t.calls, [{ key: 'nMinutesAgo', count: 5 }]);
      });

      it('picks "nMinutesAgo" exactly at the 59-min boundary', () => {
        const t = makeT();
        // 59 min 59 s — should still bucket into minutes, not hours.
        const out = formatDate(ago(59 * 60_000 + 59_000), {
          mode: 'relative',
          t,
        });
        assert.equal(out, 'nMinutesAgo:59');
      });

      it('picks "nHoursAgo" for 1..23 hr and passes count', () => {
        const t = makeT();
        const out = formatDate(ago(3 * 60 * 60_000), {
          mode: 'relative',
          t,
        });
        assert.equal(out, 'nHoursAgo:3');
        assert.deepEqual(t.calls, [{ key: 'nHoursAgo', count: 3 }]);
      });

      it('picks "nHoursAgo" exactly at the 23-hr boundary', () => {
        const t = makeT();
        const out = formatDate(ago(23 * 60 * 60_000 + 59 * 60_000 + 59_000), {
          mode: 'relative',
          t,
        });
        assert.equal(out, 'nHoursAgo:23');
      });

      it('picks "nDaysAgo" for 1..29 days and passes count', () => {
        const t = makeT();
        const out = formatDate(ago(3 * 24 * 60 * 60_000), {
          mode: 'relative',
          t,
        });
        assert.equal(out, 'nDaysAgo:3');
        assert.deepEqual(t.calls, [{ key: 'nDaysAgo', count: 3 }]);
      });

      it('picks "nDaysAgo" exactly at the 29-day boundary', () => {
        const t = makeT();
        // 29 d 23 h 59 m 59 s — just under 30 d, still days.
        const ms =
          29 * 24 * 60 * 60_000 +
          23 * 60 * 60_000 +
          59 * 60_000 +
          59_000;
        const out = formatDate(ago(ms), { mode: 'relative', t });
        assert.equal(out, 'nDaysAgo:29');
      });
    });

    describe('relative mode — falls back to absolute after 30 days', () => {
      it('returns absolute date string at the 30-day boundary', () => {
        const t = makeT();
        const iso = ago(30 * 24 * 60 * 60_000);
        const out = formatDate(iso, { mode: 'relative', t });
        // No t() call should have happened — we fell back before reaching the
        // day bucket.
        assert.equal(t.calls.length, 0);
        assert.equal(out, new Date(iso).toLocaleDateString());
      });

      it('returns absolute date string for a year-old timestamp', () => {
        const t = makeT();
        const iso = ago(400 * 24 * 60 * 60_000); // ~13 months
        const out = formatDate(iso, { mode: 'relative', t });
        assert.equal(t.calls.length, 0);
        assert.equal(out, new Date(iso).toLocaleDateString());
      });
    });

    describe('relative mode — passes only `count` to t() (no `n`)', () => {
      it('omits the legacy `n` field from the interpolation payload', () => {
        // The previous implementation passed both `count` and `n`. After the
        // H.23 P2-3 follow-up, only `count` is forwarded to t() (the
        // translation strings use `{{count}}`).
        const t = makeT();
        formatDate(ago(7 * 60_000), { mode: 'relative', t });
        assert.equal(t.calls.length, 1);
        // Spy on the raw call to make sure no extra keys are present.
        const raw = (t as unknown as { calls: Array<Record<string, unknown>> })
          .calls[0];
        assert.equal(raw.count, 7);
        assert.equal(raw.n, undefined);
      });
    });
  });
});
