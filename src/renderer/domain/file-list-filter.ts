import type { DirEntry } from '../../shared/ipc-types';
import {
  isPeriodTag,
  isStaleDateTag,
  smartFunctionalityOfTag,
  type SmartFunctionality,
} from '../../shared/smart-tags';
import { isGeoTag } from './geo-tag';

export function filterEntriesByTag(
  entries: DirEntry[],
  tagsByName: ReadonlyMap<string, readonly string[]>,
  activeTag: string | null,
  now: Date
): DirEntry[] {
  if (!activeTag) return entries;
  // Folded geo filter ("geo:") matches every file carrying a coordinate tag.
  if (activeTag === 'geo:') {
    return entries.filter((e) =>
      (tagsByName.get(e.path) ?? []).some(isGeoTag)
    );
  }
  // Folded period filter ("period:") matches every file carrying a
  // YYYYMMDD-YYYYMMDD period tag (the fold key 'period:' itself is never
  // stored on a file — see docs/03-tagging.md §5 / §8).
  if (activeTag === 'period:') {
    return entries.filter((e) =>
      (tagsByName.get(e.path) ?? []).some(isPeriodTag)
    );
  }
  // Folded stale-date filter ("date:") matches every file carrying a date-
  // shaped tag that is currently stale (out of any of the 7 freshness
  // windows). Wrapped in useNow-derived `now` so day / month / year
  // boundaries correctly re-classify at click time.
  if (activeTag === 'date:') {
    return entries.filter((e) =>
      (tagsByName.get(e.path) ?? []).some((tg) => isStaleDateTag(tg, now))
    );
  }
  // Folded smart-tag filter ("smart:today") matches every variant of that fn.
  if (activeTag.startsWith('smart:')) {
    const fn = activeTag.slice(6) as SmartFunctionality;
    return entries.filter((e) =>
      (tagsByName.get(e.path) ?? []).some(
        (tg) => smartFunctionalityOfTag(tg, now) === fn
      )
    );
  }
  return entries.filter((e) =>
    (tagsByName.get(e.path) ?? []).includes(activeTag)
  );
}
