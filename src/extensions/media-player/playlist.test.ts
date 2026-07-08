/**
 * Unit tests for the playlist pure helpers (sibling nav + loop mode + label
 * formatting). Run via `npm test` (see package.json test script). Matches the
 * repo's `node:test` + `assert/strict` convention used by image-viewer/keymap
 * and json-viewer/json-model.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  siblingTarget,
  parsePlayMode,
  cyclePlayMode,
  formatTrackLabel,
  formatTrackSize,
  pickShuffleNext,
  pushHistory,
  popHistory,
  parseShuffleOn,
  parsePlaybackRate,
  stepPlaybackRate,
  formatPlaybackRate,
  PLAYBACK_RATES,
  DEFAULT_PLAYBACK_RATE,
  parseProgressMap,
  stringifyProgressMap,
  getProgress,
  setProgress,
} from './playlist';

describe('siblingTarget', () => {
  it('returns null for an empty list', () => {
    assert.equal(siblingTarget([], 'whatever', 'next'), null);
    assert.equal(siblingTarget([], 'whatever', 'prev'), null);
    assert.equal(siblingTarget([], 'whatever', 'first'), null);
    assert.equal(siblingTarget([], 'whatever', 'last'), null);
  });

  it('returns the only element for a single-item list (all directions)', () => {
    const one = ['only.mp3'];
    assert.equal(siblingTarget(one, 'only.mp3', 'next'), 'only.mp3');
    assert.equal(siblingTarget(one, 'only.mp3', 'prev'), 'only.mp3');
    assert.equal(siblingTarget(one, 'only.mp3', 'first'), 'only.mp3');
    assert.equal(siblingTarget(one, 'only.mp3', 'last'), 'only.mp3');
  });

  it('wraps forward at the end of the list', () => {
    const paths = ['a', 'b', 'c'];
    assert.equal(siblingTarget(paths, 'c', 'next'), 'a');
    assert.equal(siblingTarget(paths, 'c', 'next'), 'a'); // repeated: still wraps
  });

  it('wraps backward at the start of the list', () => {
    const paths = ['a', 'b', 'c'];
    assert.equal(siblingTarget(paths, 'a', 'prev'), 'c');
  });

  it('returns the immediate neighbour in the middle', () => {
    const paths = ['a', 'b', 'c', 'd'];
    assert.equal(siblingTarget(paths, 'b', 'prev'), 'a');
    assert.equal(siblingTarget(paths, 'b', 'next'), 'c');
  });

  it('returns first/last as absolute endpoints (no fallback)', () => {
    const paths = ['a', 'b', 'c'];
    assert.equal(siblingTarget(paths, 'b', 'first'), 'a');
    assert.equal(siblingTarget(paths, 'b', 'last'), 'c');
  });

  it('falls back to first when `current` is not in the list (next)', () => {
    const paths = ['a', 'b', 'c'];
    // idx = -1, base = 0; next = paths[(0 + 1) % 3] = 'b'
    assert.equal(siblingTarget(paths, 'missing', 'next'), 'b');
  });

  it('falls back to last when `current` is not in the list (prev)', () => {
    const paths = ['a', 'b', 'c'];
    // idx = -1, base = 0 (clamped); prev = paths[(0 - 1 + 3) % 3] = paths[2] = 'c'.
    // This lands on the last element — pressing prev from "outside the list"
    // wraps into the list at its end, which is the natural "go to last"
    // behavior.
    assert.equal(siblingTarget(paths, 'missing', 'prev'), 'c');
  });
});

describe('parsePlayMode', () => {
  it('returns the value for valid modes', () => {
    assert.equal(parsePlayMode('list'), 'list');
    assert.equal(parsePlayMode('one'), 'one');
    assert.equal(parsePlayMode('none'), 'none');
  });

  it('falls back to `list` for null, undefined, and unknown values', () => {
    assert.equal(parsePlayMode(null), 'list');
    assert.equal(parsePlayMode(undefined), 'list');
    assert.equal(parsePlayMode(''), 'list');
    assert.equal(parsePlayMode('random'), 'list');
    assert.equal(parsePlayMode('ALL'), 'list'); // case-sensitive
  });
});

describe('cyclePlayMode', () => {
  it('cycles list → one → none → list', () => {
    assert.equal(cyclePlayMode('list'), 'one');
    assert.equal(cyclePlayMode('one'), 'none');
    assert.equal(cyclePlayMode('none'), 'list');
    assert.equal(cyclePlayMode('list'), 'one'); // back to start
  });
});

describe('formatTrackLabel', () => {
  it('returns just the basename for POSIX paths', () => {
    assert.equal(formatTrackLabel('/home/user/music/track.mp3'), 'track.mp3');
    assert.equal(formatTrackLabel('track.mp3'), 'track.mp3');
  });

  it('handles Windows backslash separators', () => {
    assert.equal(
      formatTrackLabel('C:\\Users\\XieYu\\Music\\track.flac'),
      'track.flac'
    );
  });

  it('handles mixed separators (defensive)', () => {
    assert.equal(
      formatTrackLabel('/mnt/share/music\\track.opus'),
      'track.opus'
    );
  });

  it('returns the input unchanged when there is no separator', () => {
    assert.equal(formatTrackLabel('track.mp3'), 'track.mp3');
    assert.equal(formatTrackLabel(''), '');
  });
});

describe('formatTrackSize', () => {
  it('shows "—" for missing or non-positive sizes', () => {
    assert.equal(formatTrackSize(undefined), '—');
    assert.equal(formatTrackSize(null as unknown as number), '—');
    assert.equal(formatTrackSize(0), '—');
    assert.equal(formatTrackSize(-1), '—');
    assert.equal(formatTrackSize(NaN), '—');
  });

  it('formats bytes (< 1 KB) without a unit suffix', () => {
    assert.equal(formatTrackSize(1), '1 B');
    assert.equal(formatTrackSize(512), '512 B');
    assert.equal(formatTrackSize(1023), '1023 B');
  });

  it('formats KB / MB / GB with appropriate decimals', () => {
    assert.equal(formatTrackSize(1024), '1.00 KB');
    assert.equal(formatTrackSize(1536), '1.50 KB');
    assert.equal(formatTrackSize(10 * 1024), '10.0 KB');
    assert.equal(formatTrackSize(100 * 1024), '100 KB');
    assert.equal(formatTrackSize(1024 * 1024), '1.00 MB');
    assert.equal(formatTrackSize(500 * 1024 * 1024), '500 MB');
    assert.equal(formatTrackSize(2 * 1024 * 1024 * 1024), '2.00 GB');
  });
});

describe('pickShuffleNext', () => {
  // Deterministic PRNG: returns successive values in [0, 1).
  const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it('returns null for an empty list', () => {
    assert.equal(pickShuffleNext([], 'current', seq(0.5)), null);
  });

  it('returns null when the only path is the current track', () => {
    assert.equal(pickShuffleNext(['only'], 'only', seq(0.5)), null);
  });

  it('returns the only path when it is not the current track', () => {
    assert.equal(pickShuffleNext(['only'], 'current', seq(0.5)), 'only');
  });

  it('excludes `current` from the pool', () => {
    const paths = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 50; i += 1) {
      assert.notEqual(pickShuffleNext(paths, 'b', Math.random), 'b');
    }
  });

  it('returns every non-current element across many samples (distribution check)', () => {
    const paths = ['a', 'b', 'c'];
    const seen = new Set<string>();
    // 60 random samples × 3 elements ≈ uniform coverage
    for (let i = 0; i < 60; i += 1) seen.add(pickShuffleNext(paths, 'a')!);
    assert.deepEqual([...seen].sort(), ['b', 'c']);
  });

  it('honors the injected PRNG (deterministic for tests)', () => {
    const paths = ['a', 'b', 'c'];
    // pool = ['b', 'c']; rng=0 → index floor(0 * 2) % 2 = 0 → 'b'
    assert.equal(pickShuffleNext(paths, 'a', seq(0)), 'b');
    // rng=0.49 → floor(0.49 * 2) % 2 = 0 → 'b'
    assert.equal(pickShuffleNext(paths, 'a', seq(0.49)), 'b');
    // rng=0.5 → floor(0.5 * 2) % 2 = 1 → 'c'
    assert.equal(pickShuffleNext(paths, 'a', seq(0.5)), 'c');
    // rng=0.99 → floor(0.99 * 2) % 2 = 1 → 'c'
    assert.equal(pickShuffleNext(paths, 'a', seq(0.99)), 'c');
  });

  it('handles `current` not in the list', () => {
    const paths = ['a', 'b', 'c'];
    // pool = all three; rng=0 → floor(0 * 3) = 0 → 'a'
    assert.equal(pickShuffleNext(paths, 'missing', seq(0)), 'a');
  });
});

describe('pushHistory', () => {
  it('appends to an empty history', () => {
    assert.deepEqual(pushHistory([], 'a', 10), ['a']);
  });

  it('appends to a non-empty history', () => {
    assert.deepEqual(pushHistory(['a', 'b'], 'c', 10), ['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const original = ['a'];
    const result = pushHistory(original, 'b', 10);
    assert.deepEqual(original, ['a']);
    assert.notEqual(result, original);
  });

  it('drops the oldest entries past the limit (FIFO eviction)', () => {
    const result = pushHistory(['a', 'b', 'c'], 'd', 3);
    assert.deepEqual(result, ['b', 'c', 'd']);
  });

  it('handles a 1-entry limit', () => {
    const r1 = pushHistory([], 'a', 1);
    assert.deepEqual(r1, ['a']);
    const r2 = pushHistory(r1, 'b', 1);
    assert.deepEqual(r2, ['b']);
  });

  it('de-dupes adjacent entries (tail === new path → no-op)', () => {
    assert.deepEqual(pushHistory(['a', 'b'], 'b', 10), ['a', 'b']);
  });

  it('ignores empty-string paths', () => {
    assert.deepEqual(pushHistory(['a'], '', 10), ['a']);
  });
});

describe('popHistory', () => {
  it('returns null and the same array when empty', () => {
    const r = popHistory([]);
    assert.equal(r.value, null);
    assert.deepEqual(r.history, []);
  });

  it('pops the most-recent entry (LIFO)', () => {
    const r = popHistory(['a', 'b', 'c']);
    assert.equal(r.value, 'c');
    assert.deepEqual(r.history, ['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const original = ['a', 'b'];
    const r = popHistory(original);
    assert.deepEqual(original, ['a', 'b']);
    assert.notEqual(r.history, original);
  });

  it('round-trips with pushHistory', () => {
    let h: string[] = [];
    h = pushHistory(h, 'a', 10);
    h = pushHistory(h, 'b', 10);
    h = pushHistory(h, 'c', 10);
    let r = popHistory(h);
    assert.equal(r.value, 'c');
    r = popHistory(r.history);
    assert.equal(r.value, 'b');
    r = popHistory(r.history);
    assert.equal(r.value, 'a');
    r = popHistory(r.history);
    assert.equal(r.value, null);
  });
});

describe('parseShuffleOn', () => {
  it('returns true only for the exact string "true"', () => {
    assert.equal(parseShuffleOn('true'), true);
  });

  it('returns false for null, undefined, empty, or other truthy-looking strings', () => {
    assert.equal(parseShuffleOn(null), false);
    assert.equal(parseShuffleOn(undefined), false);
    assert.equal(parseShuffleOn(''), false);
    assert.equal(parseShuffleOn('1'), false);
    assert.equal(parseShuffleOn('TRUE'), false); // case-sensitive (matches localStorage contract)
    assert.equal(parseShuffleOn('yes'), false);
  });
});

describe('parsePlaybackRate', () => {
  it('returns the canonical rate for ladder values', () => {
    for (const r of PLAYBACK_RATES) {
      assert.equal(parsePlaybackRate(String(r)), r);
    }
  });

  it('snaps near-ladder values to the closest step', () => {
    // 0.74 → closest to 0.75 (diff 0.01) vs 0.5 (diff 0.24)
    assert.equal(parsePlaybackRate('0.74'), 0.75);
    // 1.1 → closer to 1 than 1.25
    assert.equal(parsePlaybackRate('1.1'), 1);
    // 1.2 → exactly between 1 (diff 0.2) and 1.25 (diff 0.05); .indexOf returns first occurrence so 1.25
    assert.equal(parsePlaybackRate('1.2'), 1.25);
  });

  it('falls back to the default for null / undefined / empty / non-numeric', () => {
    assert.equal(parsePlaybackRate(null), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate(undefined), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate(''), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate('abc'), DEFAULT_PLAYBACK_RATE);
  });

  it('falls back to the default for invalid numeric values', () => {
    assert.equal(parsePlaybackRate('NaN'), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate('Infinity'), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate('-Infinity'), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate('0'), DEFAULT_PLAYBACK_RATE);
    assert.equal(parsePlaybackRate('-1'), DEFAULT_PLAYBACK_RATE);
  });
});

describe('stepPlaybackRate', () => {
  it('steps up through the ladder', () => {
    assert.equal(stepPlaybackRate(0.5, 'up'), 0.75);
    assert.equal(stepPlaybackRate(0.75, 'up'), 1);
    assert.equal(stepPlaybackRate(1, 'up'), 1.25);
    assert.equal(stepPlaybackRate(1.5, 'up'), 2);
  });

  it('steps down through the ladder', () => {
    assert.equal(stepPlaybackRate(2, 'down'), 1.5);
    assert.equal(stepPlaybackRate(1, 'down'), 0.75);
    assert.equal(stepPlaybackRate(0.75, 'down'), 0.5);
  });

  it('clamps at the boundaries', () => {
    assert.equal(stepPlaybackRate(0.5, 'down'), 0.5);
    assert.equal(stepPlaybackRate(2, 'up'), 2);
  });

  it('snaps out-of-ladder input before stepping', () => {
    assert.equal(stepPlaybackRate(0.74, 'up'), 1); // snaps to 0.75, then up to 1
    assert.equal(stepPlaybackRate(0.74, 'down'), 0.5); // snaps to 0.75, then down to 0.5
  });

  it('snaps garbage input to the default before stepping', () => {
    // stepPlaybackRate first calls parsePlaybackRate(String(current)), which
    // maps NaN / negative / 0 / Infinity → DEFAULT_PLAYBACK_RATE (1). Then it
    // steps from there.
    assert.equal(stepPlaybackRate(NaN as unknown as number, 'up'), 1.25); // 1 → 1.25
    assert.equal(stepPlaybackRate(NaN as unknown as number, 'down'), 0.75); // 1 → 0.75
    assert.equal(stepPlaybackRate(-1 as unknown as number, 'up'), 1.25);
    assert.equal(stepPlaybackRate(0 as unknown as number, 'down'), 0.75);
  });
});

describe('formatPlaybackRate', () => {
  it('formats integer rates without decimals', () => {
    assert.equal(formatPlaybackRate(1), '1x');
    assert.equal(formatPlaybackRate(2), '2x');
  });

  it('keeps one decimal for fractional rates that round cleanly', () => {
    assert.equal(formatPlaybackRate(0.5), '0.5x');
    assert.equal(formatPlaybackRate(1.5), '1.5x');
  });

  it('rounds to 2 decimals and trims trailing zeros', () => {
    assert.equal(formatPlaybackRate(1.234), '1.23x');
    assert.equal(formatPlaybackRate(1.236), '1.24x');
    assert.equal(formatPlaybackRate(0.5 + 0.0001), '0.5x'); // 0.5001 → rounded to 0.5
  });
});

describe('parseProgressMap', () => {
  it('returns empty for null / undefined / empty', () => {
    assert.deepEqual(parseProgressMap(null), {});
    assert.deepEqual(parseProgressMap(undefined), {});
    assert.deepEqual(parseProgressMap(''), {});
  });

  it('parses a valid JSON map', () => {
    const map = parseProgressMap('{"a.mp3": 12.5, "b.mp3": 0}');
    assert.deepEqual(map, { 'a.mp3': 12.5, 'b.mp3': 0 });
  });

  it('drops invalid entries silently (negative / non-number / null)', () => {
    // NaN doesn't survive JSON serialisation — it becomes null. Build the
    // payload through JSON.stringify so the test mirrors real localStorage
    // round-trips.
    const payload = JSON.stringify({ a: 1, b: -1, c: NaN, d: '5', e: null });
    const map = parseProgressMap(payload);
    assert.deepEqual(Object.keys(map).sort(), ['a']);
    assert.equal(map['a'], 1);
  });

  it('returns empty on non-object JSON (array, primitive)', () => {
    assert.deepEqual(parseProgressMap('[1,2,3]'), {});
    assert.deepEqual(parseProgressMap('"hi"'), {});
    assert.deepEqual(parseProgressMap('42'), {});
  });

  it('returns empty on garbage strings (no throw)', () => {
    assert.deepEqual(parseProgressMap('not json'), {});
    assert.deepEqual(parseProgressMap('{unclosed'), {});
  });

  it('rounds values to 2 decimals', () => {
    const map = parseProgressMap('{"x": 1.23456}');
    assert.equal(map['x'], 1.23);
  });
});

describe('stringifyProgressMap + parseProgressMap round-trip', () => {
  it('round-trips an empty map', () => {
    assert.deepEqual(parseProgressMap(stringifyProgressMap({})), {});
  });

  it('round-trips a populated map', () => {
    const original = { 'a.mp3': 12.34, 'b.mp3': 0 };
    assert.deepEqual(parseProgressMap(stringifyProgressMap(original)), original);
  });
});

describe('getProgress / setProgress', () => {
  it('returns 0 for unknown paths', () => {
    assert.equal(getProgress({}, 'unknown'), 0);
  });

  it('returns 0 for paths saved with 0 (defensive — never resume from 0)', () => {
    assert.equal(getProgress({ x: 0 }, 'x'), 0);
  });

  it('returns the saved value for known paths', () => {
    assert.equal(getProgress({ x: 12.5 }, 'x'), 12.5);
  });

  it('setProgress does not mutate the input', () => {
    const original = { x: 1 };
    const next = setProgress(original, 'y', 5);
    assert.deepEqual(original, { x: 1 });
    assert.deepEqual(next, { x: 1, y: 5 });
  });

  it('setProgress rounds to 2 decimals', () => {
    assert.equal(setProgress({}, 'x', 1.23456).x, 1.23);
    assert.equal(setProgress({}, 'x', 0.5 + 0.0001).x, 0.5);
  });

  it('setProgress with 0 or negative clears the entry', () => {
    const m1 = setProgress({ x: 5 }, 'x', 0);
    assert.deepEqual(m1, {});
    const m2 = setProgress({ x: 5 }, 'x', -1);
    assert.deepEqual(m2, {});
    // No-op when the entry didn't exist
    const m3 = setProgress({}, 'x', 0);
    assert.deepEqual(m3, {});
  });

  it('setProgress is a no-op when the value is unchanged (after rounding)', () => {
    const original = { x: 1.23 };
    const next = setProgress(original, 'x', 1.23);
    assert.equal(next, original); // same reference — no new object
  });

  it('setProgress ignores empty-string paths', () => {
    assert.deepEqual(setProgress({ x: 1 }, '', 5), { x: 1 });
  });
});