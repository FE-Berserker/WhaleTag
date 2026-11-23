import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../../shared/ipc-types';
import {
  buildSidecars,
  filterTrayEntries,
  haversineKm,
  sortTrayEntries,
} from './tray-data';

/** Minimal DirEntry factory for tray-data tests. */
function entry(
  name: string,
  opts: { isFile?: boolean; modified?: string } = {}
): DirEntry {
  const dot = name.lastIndexOf('.');
  const isFile = opts.isFile ?? true;
  return {
    name,
    path: `/root/${name}`,
    isFile,
    isDirectory: !isFile,
    size: 0,
    modified: opts.modified ?? '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

const located = (...names: string[]) =>
  new Set(names.map((n) => `/root/${n}`));

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    assert.equal(haversineKm({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 }), 0);
  });

  it('approximates London → Paris as ~343 km', () => {
    const km = haversineKm(
      { lat: 51.5074, lng: -0.1278 },
      { lat: 48.8566, lng: 2.3522 }
    );
    assert.ok(km > 330 && km < 355, `expected ~343km, got ${km}`);
  });

  it('is symmetric', () => {
    const a = { lat: 10, lng: 20 };
    const b = { lat: -30, lng: 120 };
    assert.equal(haversineKm(a, b), haversineKm(b, a));
  });
});

describe('buildSidecars', () => {
  it('keys sidecars by entry name (tagsByName is path-keyed)', () => {
    const file = entry('a.jpg');
    const sidecars = buildSidecars(
      [file],
      new Map([[file.path, ['geo:1,2', 'trip']]])
    );
    assert.deepEqual(sidecars, { 'a.jpg': { tags: ['geo:1,2', 'trip'] } });
  });

  it('skips entries without tags and empty tag arrays', () => {
    const a = entry('a.jpg');
    const b = entry('b.jpg');
    const sidecars = buildSidecars(
      [a, b],
      new Map([
        [a.path, []],
        [b.path, ['geo:1,2']],
      ])
    );
    assert.deepEqual(Object.keys(sidecars), ['b.jpg']);
  });

  it('returns an empty record when tagsByName is empty', () => {
    assert.deepEqual(buildSidecars([entry('a.jpg')], new Map()), {});
  });
});

describe('sortTrayEntries', () => {
  const geoByName = new Map([
    ['/root/near.jpg', { lat: 0, lng: 0 }],
    ['/root/far.jpg', { lat: 10, lng: 0 }],
  ]);

  it('name sort surfaces located entries first, then alphabetical', () => {
    const rows = [entry('b.jpg'), entry('c.jpg'), entry('a.jpg')];
    const sorted = sortTrayEntries(rows, {
      locatedPaths: located('c.jpg'),
      traySort: 'name',
      geoByName,
      center: { lat: 0, lng: 0 },
    });
    assert.deepEqual(sorted.map((e) => e.name), ['c.jpg', 'a.jpg', 'b.jpg']);
    // Input array is not mutated.
    assert.deepEqual(rows.map((e) => e.name), ['b.jpg', 'c.jpg', 'a.jpg']);
  });

  it('modified sort is newest first with a name tie-break', () => {
    const rows = [
      entry('old.jpg', { modified: '2020-01-01T00:00:00.000Z' }),
      entry('new.jpg', { modified: '2024-01-01T00:00:00.000Z' }),
      entry('tie.jpg', { modified: '2024-01-01T00:00:00.000Z' }),
    ];
    const sorted = sortTrayEntries(rows, {
      locatedPaths: new Set(),
      traySort: 'modified',
      geoByName,
      center: { lat: 0, lng: 0 },
    });
    assert.deepEqual(sorted.map((e) => e.name), ['new.jpg', 'tie.jpg', 'old.jpg']);
  });

  it('distance sort orders by proximity and pushes unlocated rows last', () => {
    const rows = [entry('unlocated.jpg'), entry('far.jpg'), entry('near.jpg')];
    const sorted = sortTrayEntries(rows, {
      locatedPaths: located('far.jpg', 'near.jpg'),
      traySort: 'distance',
      geoByName,
      center: { lat: 0, lng: 0 },
    });
    assert.deepEqual(sorted.map((e) => e.name), [
      'near.jpg',
      'far.jpg',
      'unlocated.jpg',
    ]);
  });

  it('distance sort falls back to name order between two unlocated rows', () => {
    const rows = [entry('z.jpg'), entry('a.jpg')];
    const sorted = sortTrayEntries(rows, {
      locatedPaths: new Set(),
      traySort: 'distance',
      geoByName,
      center: { lat: 0, lng: 0 },
    });
    assert.deepEqual(sorted.map((e) => e.name), ['a.jpg', 'z.jpg']);
  });
});

describe('filterTrayEntries', () => {
  const rows = [entry('beach.jpg'), entry('Beach-house.png'), entry('doc.pdf')];
  const locatedPaths = located('beach.jpg');

  it('all filter keeps every row', () => {
    const out = filterTrayEntries(rows, {
      trayFilter: 'all',
      locatedPaths,
      nameQuery: '',
    });
    assert.equal(out.length, 3);
  });

  it('located / unlocated filters use locatedPaths', () => {
    assert.deepEqual(
      filterTrayEntries(rows, { trayFilter: 'located', locatedPaths, nameQuery: '' }).map(
        (e) => e.name
      ),
      ['beach.jpg']
    );
    assert.deepEqual(
      filterTrayEntries(rows, {
        trayFilter: 'unlocated',
        locatedPaths,
        nameQuery: '',
      }).map((e) => e.name),
      ['Beach-house.png', 'doc.pdf']
    );
  });

  it('name query is case-insensitive, trimmed, and composes with the filter', () => {
    assert.deepEqual(
      filterTrayEntries(rows, {
        trayFilter: 'all',
        locatedPaths,
        nameQuery: '  BEACH ',
      }).map((e) => e.name),
      ['beach.jpg', 'Beach-house.png']
    );
    assert.deepEqual(
      filterTrayEntries(rows, {
        trayFilter: 'located',
        locatedPaths,
        nameQuery: 'beach',
      }).map((e) => e.name),
      ['beach.jpg']
    );
  });

  it('blank query is a no-op beyond the located filter', () => {
    assert.deepEqual(
      filterTrayEntries(rows, { trayFilter: 'all', locatedPaths, nameQuery: '   ' }).map(
        (e) => e.name
      ),
      ['beach.jpg', 'Beach-house.png', 'doc.pdf']
    );
  });
});
