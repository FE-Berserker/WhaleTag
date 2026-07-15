import { useEffect, useMemo, useRef, useState } from 'react';
import {
  List as VirtualList,
  useDynamicRowHeight,
  type RowComponentProps,
} from 'react-window';

import type { DirEntry } from '../../shared/ipc-types';
import EntryCard, { CARD_MIN_HEIGHT } from './EntryCard';
import type { FileCellData } from './file-cell';

/**
 * Virtualized vertical stack of `<EntryCard>`s, used by the Kanban columns and
 * the Matrix quadrants — the two places where a single stage/quadrant can hold
 * hundreds of cards. The horizontal trays (Matrix `UntaggedTray`, Gantt Triage)
 * are thin capped strips that already scroll horizontally, so they stay on the
 * plain `entries.map` path.
 *
 * P0-4② (perf audit): the memo on `<EntryCard>` (P0-4①) already stops unrelated
 * re-renders from rebuilding the cards; this component additionally caps how
 * many cards are *mounted* at once, so a 500-card column only pays for the
 * visible window + overscan. react-window v2 `List` + `useDynamicRowHeight`
 * (cards vary in height: 84px min, taller when tag chips wrap).
 *
 * Drag-and-drop is unaffected: the drop target is the column/quadrant Box that
 * WRAPS this stack (it stays mounted regardless of which cards are virtualized
 * in/out), and each visible `<EntryCard>` keeps its own `useDrag`. There is no
 * in-column positional reordering (workflow stages are categorical), so no
 * card-level drop target is needed.
 */
export interface EntryCardStackProps {
  entries: DirEntry[];
  data: FileCellData;
  renderContextMenu: (entry: DirEntry, x: number, y: number) => void;
}

interface RowData {
  entries: DirEntry[];
  data: FileCellData;
  renderContextMenu: (entry: DirEntry, x: number, y: number) => void;
}

// Plain function component (NOT memo'd) — react-window v2's `rowComponent`
// expects a function, not a memo wrapper (NamedExoticComponent). Re-renders are
// cheap: the `<EntryCard>` inside is already memo'd (P0-4①) and bails out when
// its props are stable, and `rowData` is memoized below so react-window doesn't
// re-render rows on unrelated parent updates.
function EntryCardStackRow({
  index,
  style,
  entries,
  data,
  renderContextMenu,
}: RowComponentProps<RowData>) {
  const entry = entries[index];
  if (!entry) return <div style={style} />;
  // `display:flex; flexDirection:column` makes the card a flex item, so its
  // `mb: 1` margin counts toward the row's measured height (flex items don't
  // collapse margins the way block children do). Without this the inter-card
  // gap would be lost — react-window measures the row's offsetHeight, which
  // excludes a block child's bottom margin.
  return (
    <div style={{ ...style, display: 'flex', flexDirection: 'column' }}>
      <EntryCard
        entry={entry}
        data={data}
        renderContextMenu={renderContextMenu}
      />
    </div>
  );
}

export default function EntryCardStack({
  entries,
  data,
  renderContextMenu,
}: EntryCardStackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);

  // Measure the available height so react-window fills the column body. In
  // jsdom (tests) getBoundingClientRect is 0, so `height` stays at the default
  // and the list renders rows at `defaultRowHeight` — small test boards still
  // mount every card.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setHeight(h);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dynamic measurement: real heights come from the DOM once rows paint (card
  // + its `mb:1` gap); until then rows use the default. `key` invalidates the
  // cache when the board size changes so stale per-index heights don't bleed
  // across a reshuffle.
  const rowHeight = useDynamicRowHeight({
    defaultRowHeight: CARD_MIN_HEIGHT + 8,
    key: entries.length,
  });

  const rowData = useMemo<RowData>(
    () => ({ entries, data, renderContextMenu }),
    [entries, data, renderContextMenu]
  );

  return (
    <div ref={containerRef} style={{ height: '100%', minHeight: 0 }}>
      <VirtualList
        style={{ height }}
        rowCount={entries.length}
        rowHeight={rowHeight}
        rowComponent={EntryCardStackRow}
        rowProps={rowData}
      />
    </div>
  );
}
