/**
 * P2-2 / P2-5 / P2-10: guards for render-discipline fixes whose cost is not
 * observable from the DOM.
 *
 * Why a source-level test: the regressions these guard against are invisible
 * to a rendered-output assertion —
 *   - a memoised child receiving a fresh object literal still renders the same
 *     markup, it just does the work again;
 *   - `useEffect(() => forceRender(), [map])` only adds a commit, and the
 *     commit count of `MapiqueView` legitimately varies with marker/tray
 *     effects, so a profiler assertion cannot separate the two;
 *   - a hand-maintained dependency array with an `eslint-disable` compiles and
 *     behaves exactly like the drift-proof bag until a field is added.
 * Each test therefore pins the *shape* of the workaround, and the comment in
 * the production file says why. Reintroducing the pattern fails loudly here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

function eslintDisableDirectives(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => /^\s*(\/\/|\/\*)\s*eslint-disable/.test(line));
}

describe('view render discipline', () => {
  it('MapiqueView does not bump its own render', () => {
    const source = read('MapiqueView.tsx');
    assert.doesNotMatch(
      source,
      /forceRender/,
      'no self-triggered render: props in, render out'
    );
    assert.doesNotMatch(source, /useReducer/);
  });

  it('FileList does not remount MapiqueView with a key prop', () => {
    // P2 split: the per-view switch (and the historical note) moved out of
    // FileList into FileListView.
    const source = read('file-list/FileListView.tsx');
    const start = source.lastIndexOf('<MapiqueView');
    assert.ok(start > 0, 'FileList must render MapiqueView');
    const end = source.indexOf('/>', start);
    assert.ok(end > start);
    assert.doesNotMatch(
      source.slice(start, end),
      /\bkey=/,
      'a key here would discard the map/tray state on every tag change'
    );
  });

  it('FileList passes the memoised column labels, never an object literal', () => {
    const source = read('FileList.tsx');
    assert.match(source, /columnLabels=\{columnLabels\}/);
    assert.doesNotMatch(source, /columnLabels=\{\{/);
  });

  it('RowColumnLabels stays memoised so the label bag is worth stabilising', () => {
    const source = read('FileListHeader.tsx');
    assert.match(source, /export const RowColumnLabels = memo\(/);
  });

  it('FileList dependency bags are drift-proof, not hand-maintained', () => {
    // P2 split: the two bags are built by their own hooks now.
    const commandsDeps = read('file-list/useCommandsDeps.ts');
    const cellData = read('file-list/useFileListCellData.ts');
    assert.match(commandsDeps, /useStableBag<ListCommandsDeps>/);
    assert.match(cellData, /useStableBag<FileCellData>/);
    assert.deepEqual(
      [
        ...eslintDisableDirectives(read('FileList.tsx')),
        ...eslintDisableDirectives(commandsDeps),
        ...eslintDisableDirectives(cellData),
      ],
      [],
      'the exhaustive-deps disables were the drift risk; they must stay gone'
    );
  });

  it('hot-path path→entry lookups go through the host maps', () => {
    // P2-8: these four views used to walk `entries` per click / per drop. The
    // host backs `resolveEntry` / `entryIndex` with Maps (FileList.tsx), so the
    // helpers below are O(1) in production and keep an O(N) fallback only for
    // hosts that don't provide one. A re-inlined `entries.find(...)` would
    // still pass every DOM assertion, hence this guard.
    for (const file of [
      'EntryCard.tsx',
      'calendar/CalendarEntryItem.tsx',
      'calendar/DayCell.tsx',
      'GanttView.tsx',
      'KnowledgeGraphView.tsx',
    ]) {
      const source = read(file);
      assert.match(source, /lookupEntr/, `${file} must use the shared lookup`);
      assert.doesNotMatch(
        source,
        /\bentries\s*\.\s*find(Index)?\s*\(/,
        `${file} must not scan entries on the hot path`
      );
    }
  });

  it('the list date format reaches the grid and the properties tray', () => {
    // P2-7: Row already honoured `listDateFormat`; the grid cell and the tray's
    // "modified" row emitted absolute time regardless of the setting. The
    // PropertiesTray suite covers the rendered string; this pins the two call
    // sites so a future edit cannot drop the `mode` option again.
    assert.match(
      read('GridCell.tsx'),
      /formatDate\(entry\.modified,\s*\{\s*mode:\s*listDateFormat,\s*t\s*\}\)/
    );
    assert.match(
      read('PropertiesTray.tsx'),
      /formatDate\(single\.modified,\s*\{\s*mode:\s*listDateFormat,\s*t\s*\}\)/
    );
  });
});
