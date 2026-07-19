import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isAnyDateShapeTag } from '../../shared/smart-tags';
import { tagDisplayLabel } from '-/services/tag-display';
import { subscribeNow, getNowSnapshot } from './useNow';

/**
 * Localized display labels for a list of tags, freshness-aware (docs/03).
 *
 * Only the date-family tags (smart date ×7 / bare `YYYYMMDD` / legacy
 * prefixed forms) have `now`-dependent labels — `20260704` renders as
 * "今天" on that day and as the raw string the day after. This hook
 * subscribes to the shared per-minute `useNow` store ONLY when at least one
 * shown tag is date-shaped, so the overwhelmingly common date-free chip
 * component never re-renders on the minute tick (the reason a plain
 * `useNow()` in every chip was rejected).
 *
 * Replaces per-call-site `tagDisplayLabel(tag, t)` (which defaulted
 * `now = new Date()` and therefore never refreshed across a day boundary
 * while the app stayed open).
 */
export function useTagDisplayLabels(tags: string[]): string[] {
  const { t } = useTranslation();
  const needsNow = useMemo(() => tags.some(isAnyDateShapeTag), [tags]);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    if (!needsNow) return undefined;
    // Catch up immediately — the shared snapshot may be fresher than the
    // labels rendered before this subscription became active.
    setNow(getNowSnapshot());
    return subscribeNow(() => setNow(getNowSnapshot()));
  }, [needsNow]);

  return useMemo(
    () =>
      tags.map((tag) =>
        tagDisplayLabel(tag, t, now ?? new Date())
      ),
    [tags, t, now]
  );
}

/** Single-tag convenience wrapper over {@link useTagDisplayLabels}. */
export function useTagDisplayLabel(tag: string): string {
  const tags = useMemo(() => [tag], [tag]);
  const [label] = useTagDisplayLabels(tags);
  return label;
}
