import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGeoCandidate,
  geoEntries,
  entriesNeedingExif,
  fitBounds,
  pruneSelection,
} from './mapique';
import type { DirEntry } from './ipc-types';
import type { SidecarMeta } from './whale-meta';

/** Minimal DirEntry factory for mapique tests. */
function entry(name: string, isFile = true): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile,
    isDirectory: !isFile,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

describe('mapique isGeoCandidate', () => {
  it('accepts image files', () => {
    assert.ok(isGeoCandidate(entry('photo.jpg')));
    assert.ok(isGeoCandidate(entry('image.PNG')));
  });

  it('accepts video files', () => {
    assert.ok(isGeoCandidate(entry('clip.mp4')));
    assert.ok(isGeoCandidate(entry('movie.MOV')));
  });

  it('rejects directories', () => {
    assert.ok(!isGeoCandidate(entry('folder', false)));
  });

  it('rejects non-media files without geo tags', () => {
    assert.ok(!isGeoCandidate(entry('doc.pdf')));
    assert.ok(!isGeoCandidate(entry('notes.txt')));
  });

  it('accepts non-media files that already carry a geo tag', () => {
    assert.ok(
      isGeoCandidate(entry('report.pdf'), {
        'report.pdf': { tags: ['geo:31.2304,121.4737'] },
      })
    );
  });
});

describe('mapique geoEntries', () => {
  it('returns only entries with a geo: tag', () => {
    const entries = [entry('a.jpg'), entry('b.jpg'), entry('c.jpg')];
    const sidecars: Record<string, SidecarMeta> = {
      'a.jpg': { tags: ['geo:48.8566,2.352200'] },
      'b.jpg': {},
      'c.jpg': { tags: ['geo:40.712800,-74.006000'] },
    };
    const geo = geoEntries(entries, sidecars);
    assert.equal(geo.length, 2);
    assert.equal(geo[0].entry.name, 'a.jpg');
    assert.equal(geo[0].lat, 48.8566);
    assert.equal(geo[1].entry.name, 'c.jpg');
  });

  it('ignores invalid geo tags', () => {
    const entries = [entry('bad.jpg')];
    const sidecars: Record<string, SidecarMeta> = {
      'bad.jpg': { tags: ['geo:not-a-coord'] },
    };
    assert.deepEqual(geoEntries(entries, sidecars), []);
  });

  it('returns empty when no entries have GPS', () => {
    assert.deepEqual(
      geoEntries([entry('x.jpg'), entry('y.mov')], {}),
      []
    );
  });

  it('reads coordinates from a single geo tag', () => {
    const entries = [entry('a.txt')];
    const sidecars: Record<string, SidecarMeta> = {
      'a.txt': { tags: ['geo:31.2304,121.4737'] },
    };
    const geo = geoEntries(entries, sidecars);
    assert.equal(geo.length, 1);
    assert.equal(geo[0].entry.name, 'a.txt');
    assert.equal(geo[0].lat, 31.2304);
    assert.equal(geo[0].lng, 121.4737);
    assert.equal(geo[0].source, 'tag');
  });

  // `source` is a literal `'tag'` after the 2026-06-30 schema change (the
  // sidecar no longer carries parallel lat/lng fields — the geo: tag is the
  // single source of truth). The field stays in the type so future code can
  // distinguish EXIF-discovered vs manually-added coordinates without an
  // interface change.
  it('always returns source = "tag"', () => {
    const entries = [
      entry('from-tag.txt'),
      entry('untouched.jpg'),
    ];
    const sidecars: Record<string, SidecarMeta> = {
      'from-tag.txt': { tags: ['geo:1.5,2.5'] },
      'untouched.jpg': {},
    };
    const sources = new Set(geoEntries(entries, sidecars).map((g) => g.source));
    assert.equal(sources.size, 1);
    assert.ok(sources.has('tag'));
  });
});

describe('mapique entriesNeedingExif', () => {
  it('returns media files without a geo: tag', () => {
    const entries = [entry('has.jpg'), entry('missing.jpg'), entry('doc.pdf')];
    const sidecars: Record<string, SidecarMeta> = {
      'has.jpg': { tags: ['geo:1.000000,2.000000'] },
    };
    const missing = entriesNeedingExif(entries, sidecars);
    assert.deepEqual(
      missing.map((e) => e.name),
      ['missing.jpg']
    );
  });

  it('returns empty when all media files have a geo: tag', () => {
    const entries = [entry('a.jpg')];
    const sidecars: Record<string, SidecarMeta> = {
      'a.jpg': { tags: ['geo:1.000000,2.000000'] },
    };
    assert.deepEqual(entriesNeedingExif(entries, sidecars), []);
  });
});

describe('mapique fitBounds', () => {
  it('defaults to a whole-of-China overview for empty input', () => {
    const result = fitBounds([]);
    assert.deepEqual(result.center, [35.8617, 104.1954]);
    assert.equal(result.zoom, 4);
  });

  it('uses a sensible zoom for a single point', () => {
    const result = fitBounds([{ lat: 48.8566, lng: 2.3522 }]);
    assert.deepEqual(result.center, [48.8566, 2.3522]);
    assert.equal(result.zoom, 10);
  });

  it('fits multiple points', () => {
    const result = fitBounds([
      { lat: 0, lng: 0 },
      { lat: 10, lng: 10 },
    ]);
    assert.equal(result.center[0], 5);
    assert.equal(result.center[1], 5);
    assert.ok(result.zoom >= 2 && result.zoom <= 18);
  });

  it('clamps zoom to sane bounds for very close points', () => {
    const result = fitBounds([
      { lat: 48.8566, lng: 2.3522 },
      { lat: 48.8567, lng: 2.3523 },
    ]);
    assert.equal(result.center[0], 48.85665);
    assert.ok(result.zoom >= 2 && result.zoom <= 18);
  });
});

describe('mapique pruneSelection (plan §H.21 P2-2)', () => {
  it('drops paths that are no longer in the listing', () => {
    const selected = new Set(['/a', '/b', '/c']);
    const valid = new Set(['/b']);
    const result = pruneSelection(selected, valid);
    assert.deepEqual([...result].sort(), ['/b']);
  });

  it('returns a new Set reference when something was removed', () => {
    const selected = new Set(['/a', '/b']);
    const valid = new Set(['/b']);
    const result = pruneSelection(selected, valid);
    assert.notEqual(result, selected, 'new Set is required so React re-renders');
  });

  it('returns the SAME Set reference when nothing changed (React optimization)', () => {
    const selected = new Set(['/a', '/b']);
    const valid = new Set(['/a', '/b', '/c']);
    const result = pruneSelection(selected, valid);
    assert.equal(
      result,
      selected,
      'identical reference is the whole point — avoid a needless re-render'
    );
  });

  it('handles empty selection (returns empty set, no crash)', () => {
    const result = pruneSelection(new Set(), new Set(['/a']));
    assert.equal(result.size, 0);
  });

  it('handles empty valid paths (clears everything, returns new set)', () => {
    const selected = new Set(['/a', '/b']);
    const valid = new Set<string>();
    const result = pruneSelection(selected, valid);
    assert.equal(result.size, 0);
    assert.notEqual(result, selected);
  });

  it('preserves paths that exist in valid', () => {
    const selected = new Set(['/a', '/b', '/c']);
    const valid = new Set(['/b', '/d']);
    const result = pruneSelection(selected, valid);
    assert.deepEqual([...result].sort(), ['/b']);
  });

  // Correctness probe — confirms the loop visits every selected path and
  // consults validPaths.has() each time, which is the O(prev.size) contract
  // that replaces the old O(prev.size × valid.size) `Array.some()` scan.
  it('consults validPaths exactly once per selected entry', () => {
    const selected = new Set(['/a', '/b', '/c', '/d']);
    const valid = new Set(['/b', '/d']);
    let probes = 0;
    // Wrap `has` via a `get` trap so Set's internal `.has(key)` calls route
    // through our counter. The plain `has` trap only fires for the `in`
    // operator, which Set doesn't use internally.
    const validProbe = new Proxy(valid, {
      get(target, prop, receiver) {
        if (prop === 'has') {
          return (key: string) => {
            probes += 1;
            return Reflect.get(target, prop, receiver).call(target, key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    pruneSelection(selected, validProbe);
    assert.equal(probes, 4, 'must check validPaths once per selected path');
  });
});
