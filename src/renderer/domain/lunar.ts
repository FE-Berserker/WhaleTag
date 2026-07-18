/**
 * Chinese-lunar helpers for the Calendar perspective (P2-6). Opt-in via the
 * `settings.showLunar` toggle and rendered only for zh-locale users, so this
 * module is imported unconditionally but only *called* when the feature is on
 * (keeps `lunar-typescript`'s data out of the hot path).
 */
import { Lunar } from 'lunar-typescript';

/**
 * Compact lunar label for a day, in the traditional calendar style:
 * - On the first day of a lunar month (初一) �?the lunar month name ("五月",
 *   "腊月"�? so the user can see where the lunar month breaks.
 * - Any other day �?just the lunar day ("十七", "廿三"�?.
 *
 * Returns '' if `lunar-typescript` can't resolve the date (it throws on some
 * far-past/far-future inputs) �?callers render nothing rather than crash.
 */
export function lunarDayLabel(date: Date): string {
  try {
    const lunar = Lunar.fromDate(date);
    const day = lunar.getDayInChinese();
    return day === '初一' ? `${lunar.getMonthInChinese()}月` : day;
  } catch {
    return '';
  }
}
