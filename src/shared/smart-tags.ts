/**
 * Smart tags: tag *templates* that resolve to a concrete value at apply time.
 *
 *   "now"     ->  "20260704T1430"   (active within 5 min; else stale → null)
 *   "today"   ->  "20260704"
 *   "month"   ->  "202607"
 *   "★★★"    ->  "3star"
 *   "To-Do"   ->  "todo"
 *
 * Storage form (post §1): the resolved value is written **without** the
 * template prefix; the date itself IS the stored tag. The legacy `today-…`
 * / `week-…` / `month-…` / `year-…` / `now-…` forms remain readable via
 * `smartFunctionalityOfTag` until the Phase-4 migration rewrites them.
 *
 * Mirrors TagSpaces' smart-tags concept, but Whale writes the RESOLVED value
 * into the sidecar's tags array (never into the filename — see plan §6.2).
 *
 * Three families ship here, each with TagSpaces-compatible stored values so
 * files tagged in either app read back the same:
 *  - the time-based set (now / today / … → dated values; freshness-checked)
 *  - the 1–5 star ratings (`1star`..`5star`, matches TagSpaces' "Ratings" group)
 *  - a project workflow (`not-started` / `in-progress` / `abandoned` /
 *    `completed` / `planned`) — Whale's own status set, hyphenated so each value
 *    stays a single whitespace-free token (tag input splits on whitespace).
 *
 * Ratings, workflow, **date**, and **period** are each MUTUALLY EXCLUSIVE —
 * a file carries at most one of each (see withSingleRating / withSingleWorkflow
 * / withSingleDateTag / withSinglePeriodTag / normalizeSmartTags). Period is an
 * independent family from date: a file can carry one date tag AND one period
 * tag simultaneously.
 *
 * `geoTagging` (which need a picker dialog) is intentionally omitted for now —
 * add a `SmartFunctionality` variant + a `resolveSmartTag` case when needed.
 */

import { isPeriodTag } from './calendar';

export { isPeriodTag } from './calendar';

export type SmartFunctionality =
  | 'now'
  | 'today'
  | 'yesterday'
  | 'tomorrow'
  | 'nextWeek'
  | 'currentMonth'
  | 'currentYear'
  | 'star1'
  | 'star2'
  | 'star3'
  | 'star4'
  | 'star5'
  | 'workflowNotStarted'
  | 'workflowInProgress'
  | 'workflowAbandoned'
  | 'workflowCompleted'
  | 'workflowPlanned'
  | 'quadrantUrgentImportant'
  | 'quadrantUrgentNotImportant'
  | 'quadrantNotUrgentImportant'
  | 'quadrantNotUrgentNotImportant';

export interface SmartTagDef {
  functionality: SmartFunctionality;
  /** Display title / drag label (the resolved value is what gets stored). */
  title: string;
}

/** The built-in, read-only time smart-tag set shown in the library. */
export const SMART_TAGS: SmartTagDef[] = [
  { functionality: 'now', title: 'now' },
  { functionality: 'today', title: 'today' },
  { functionality: 'yesterday', title: 'yesterday' },
  { functionality: 'tomorrow', title: 'tomorrow' },
  { functionality: 'nextWeek', title: 'next week' },
  { functionality: 'currentMonth', title: 'this month' },
  { functionality: 'currentYear', title: 'this year' },
];

/** Gold used for every rating chip (matches TagSpaces' Ratings group #ffcc24). */
export const RATING_COLOR = '#ffcc24';

/**
 * Accent color for `period:` (期间) fold chip in the tag library (§6 user
 * approved 2026-07-04). Distinct from the smart-date family (no built-in
 * color), ratings (gold), workflow / quadrant (4-color per-state), geo
 * (blue), and `date:` (grey, §9).
 */
export const PERIOD_COLOR = '#8b5cf6'; // violet (Tailwind violet-500)

/**
 * The 1–5 star ratings, ordered low→high. Each resolves to `<n>star`
 * (TagSpaces-compatible). Titles are the filled-star glyph repeated n times —
 * language-independent, so they need no i18n.
 */
export const RATING_TAGS: SmartTagDef[] = [
  { functionality: 'star1', title: '★' },
  { functionality: 'star2', title: '★★' },
  { functionality: 'star3', title: '★★★' },
  { functionality: 'star4', title: '★★★★' },
  { functionality: 'star5', title: '★★★★★' },
];

/**
 * Star count (1–5) for a rating functionality, or null if `fn` is a time tag.
 * Lets callers detect ratings without enumerating each `starN` variant.
 */
export function ratingOfFunctionality(fn: SmartFunctionality): number | null {
  const m = /^star([1-5])$/.exec(fn);
  return m ? Number(m[1]) : null;
}

/**
 * Display label for a smart tag's chip. Ratings render as star glyphs
 * (`★★★`), which are the same in every language, so this returns them directly.
 * Returns null for time tags — those must be translated by the caller via
 * `t(smartTagI18nKey(fn))`.
 */
export function smartTagGlyph(fn: SmartFunctionality): string | null {
  const stars = ratingOfFunctionality(fn);
  return stars ? '★'.repeat(stars) : null;
}

/**
 * Star count (1–5) for a concrete rating *value* (`3star` -> 3), or null if the
 * tag isn't a rating. This is the stored form (what lives on a file); the
 * sibling `ratingOfFunctionality` works on the template form (`star3`).
 */
export function ratingOfTag(tag: string): number | null {
  const m = /^([1-5])star$/.exec(tag);
  return m ? Number(m[1]) : null;
}

/** True when `tag` is a rating value (`1star`..`5star`). */
export function isRatingTag(tag: string): boolean {
  return ratingOfTag(tag) !== null;
}

/** Green used for every workflow chip (matches TagSpaces' workflow group #008000). */
export const WORKFLOW_COLOR = '#008000';

/** Per-workflow-state colors so statuses are visually distinguishable. */
export const WORKFLOW_COLORS: Record<string, string> = {
  'not-started': '#6b7280', // gray
  'in-progress': '#3b82f6', // blue
  'abandoned': '#ef4444', // red
  'completed': '#22c55e', // green
  'planned': '#f59e0b', // amber
};

/**
 * The project workflow states, in display order. `functionality` is the stable
 * identity (drives the i18n label key); `value` is the hyphenated token stored
 * on the file. Kept as explicit pairs (not derived) so multi-word states like
 * "In Progress" map to a clean single-token value `in-progress`.
 */
export const DEFAULT_WORKFLOW_DEFS = [
  { functionality: 'workflowNotStarted', value: 'not-started' },
  { functionality: 'workflowInProgress', value: 'in-progress' },
  { functionality: 'workflowCompleted', value: 'completed' },
  { functionality: 'workflowAbandoned', value: 'abandoned' },
  { functionality: 'workflowPlanned', value: 'planned' },
] as const satisfies readonly {
  functionality: SmartFunctionality;
  value: string;
}[];

const WORKFLOW_DEFS = DEFAULT_WORKFLOW_DEFS;

const WORKFLOW_VALUE_BY_FN = new Map<SmartFunctionality, string>(
  WORKFLOW_DEFS.map((d) => [d.functionality, d.value])
);
const WORKFLOW_FN_BY_VALUE = new Map<string, SmartFunctionality>(
  WORKFLOW_DEFS.map((d) => [d.value, d.functionality])
);

/** The built-in workflow smart-tag set shown in the library. */
export const WORKFLOW_TAGS: SmartTagDef[] = WORKFLOW_DEFS.map((d) => ({
  functionality: d.functionality,
  title: d.value,
}));

/** Color for a workflow functionality; falls back to the old single green. */
export function workflowColor(fn: SmartFunctionality): string {
  const value = WORKFLOW_VALUE_BY_FN.get(fn);
  return (value && WORKFLOW_COLORS[value]) ?? WORKFLOW_COLOR;
}

/** True when `fn` is one of the workflow functionalities. */
export function isWorkflowFunctionality(fn: SmartFunctionality): boolean {
  return WORKFLOW_VALUE_BY_FN.has(fn);
}

/**
 * Workflow functionality for a concrete value (`in-progress` ->
 * `workflowInProgress`), or null if the tag isn't a workflow state. The stored
 * form; mirrors `ratingOfTag`.
 */
export function workflowFunctionalityOfTag(
  tag: string
): SmartFunctionality | null {
  return WORKFLOW_FN_BY_VALUE.get(tag) ?? null;
}

/** True when `tag` is a workflow value (`not-started` … `planned`). */
export function isWorkflowTag(tag: string): boolean {
  return WORKFLOW_FN_BY_VALUE.has(tag);
}

/**
 * Eisenhower task-quadrant smart tags — a fixed, mutually-exclusive set of four
 * (urgent×important matrix). Like ratings/workflow, the stored value is a single
 * hyphenated token; the display label is localized via smartTagI18nKey.
 */
export const QUADRANT_COLORS: Record<string, string> = {
  'urgent-important': '#ef4444', // do first — red
  'urgent-unimportant': '#f59e0b', // delegate — amber
  'noturgent-important': '#3b82f6', // schedule — blue
  'noturgent-unimportant': '#6b7280', // eliminate — gray
};

/** The four quadrants in display order (Q1→Q4). */
export const QUADRANT_DEFS = [
  { functionality: 'quadrantUrgentImportant', value: 'urgent-important' },
  { functionality: 'quadrantUrgentNotImportant', value: 'urgent-unimportant' },
  { functionality: 'quadrantNotUrgentImportant', value: 'noturgent-important' },
  {
    functionality: 'quadrantNotUrgentNotImportant',
    value: 'noturgent-unimportant',
  },
] as const satisfies readonly {
  functionality: SmartFunctionality;
  value: string;
}[];

const QUADRANT_VALUE_BY_FN = new Map<SmartFunctionality, string>(
  QUADRANT_DEFS.map((d) => [d.functionality, d.value])
);
const QUADRANT_FN_BY_VALUE = new Map<string, SmartFunctionality>(
  QUADRANT_DEFS.map((d) => [d.value, d.functionality])
);

/** The built-in quadrant smart-tag set shown in the library. */
export const QUADRANT_TAGS: SmartTagDef[] = QUADRANT_DEFS.map((d) => ({
  functionality: d.functionality,
  title: d.value,
}));

/** All four quadrant tokens, in order (the board axis for the matrix view). */
export const QUADRANT_VALUES: string[] = QUADRANT_DEFS.map((d) => d.value);

/** Color for a quadrant functionality. */
export function quadrantColor(fn: SmartFunctionality): string | undefined {
  const value = QUADRANT_VALUE_BY_FN.get(fn);
  return value ? QUADRANT_COLORS[value] : undefined;
}

/** True when `fn` is one of the quadrant functionalities. */
export function isQuadrantFunctionality(fn: SmartFunctionality): boolean {
  return QUADRANT_VALUE_BY_FN.has(fn);
}

/** Quadrant functionality for a concrete value, or null if not a quadrant tag. */
export function quadrantFunctionalityOfTag(
  tag: string
): SmartFunctionality | null {
  return QUADRANT_FN_BY_VALUE.get(tag) ?? null;
}

/** True when `tag` is a quadrant value. */
export function isQuadrantTag(tag: string): boolean {
  return QUADRANT_FN_BY_VALUE.has(tag);
}

/**
 * The built-in accent color for a smart-tag *functionality*, or undefined for
 * time tags (which use the user/auto palette). Used by the library's folded
 * chips. The value-keyed sibling lives in tag-colors' getTagColor.
 */
export function smartTagColor(fn: SmartFunctionality): string | undefined {
  if (ratingOfFunctionality(fn)) return RATING_COLOR;
  if (isWorkflowFunctionality(fn)) return workflowColor(fn);
  if (isQuadrantFunctionality(fn)) return quadrantColor(fn);
  return undefined;
}

/**
 * Enforces "at most one tag from an exclusive set" by keeping the LAST member
 * and dropping every earlier one. Every apply path appends the freshly-chosen
 * tag to the end of the list, so "last wins" means the newest choice replaces
 * the previous one; non-member tags keep their position. No-op for 0/1 members.
 *
 * Exported because the Phase-4 migration (`main/migrate-date-tags.ts`) reuses
 * this generic互斥 function with a custom predicate.
 */
export function withSingleFrom(
  tags: string[],
  isMember: (tag: string) => boolean
): string[] {
  let lastIdx = -1;
  for (let i = 0; i < tags.length; i += 1) {
    if (isMember(tags[i])) lastIdx = i;
  }
  if (lastIdx === -1) return tags;
  return tags.filter((tag, i) => i === lastIdx || !isMember(tag));
}

/** One rating per file: keep the newest `<n>star`, drop earlier ones. */
export function withSingleRating(tags: string[]): string[] {
  return withSingleFrom(tags, isRatingTag);
}

/** One workflow status per file: keep the newest, drop earlier ones. */
export function withSingleWorkflow(tags: string[]): string[] {
  return withSingleFrom(tags, isWorkflowTag);
}

/** One task quadrant per file: keep the newest, drop earlier ones. */
export function withSingleQuadrant(tags: string[]): string[] {
  return withSingleFrom(tags, isQuadrantTag);
}

/**
 * Keep at most one tag from a caller-supplied exclusive set `values` (newest
 * wins), preserving non-members. The dynamic counterpart to withSingleWorkflow:
 * used once workflow stages are user-customizable (the value set comes from the
 * `workflow` redux slice, not the hardcoded WORKFLOW_DEFS).
 */
export function withSingleFromValues(
  tags: string[],
  values: readonly string[]
): string[] {
  const set = new Set(values);
  return withSingleFrom(tags, (tag) => set.has(tag));
}

/**
 * True when `tag` is one of the 7 date-family functionalities and is currently
 * FRESH with respect to `now` (default `new Date()`). Stale tags are NOT
 * considered part of the exclusive family — see docs/03-tagging.md §3 for the
 * freshness rule and §8 for the `日期` fold chip that captures them.
 *
 * Note: this is the **date family only** (today / yesterday / tomorrow /
 * nextWeek / now / currentMonth / currentYear). Rating (`starN`) / workflow /
 * quadrant are time-independent and have their own predicates (`isRatingTag`
 * / `isWorkflowTag` / `isQuadrantTag`); a previous version conflated them with
 * this function via `smartFunctionalityOfTag` and was wrong.
 *
 * Predicate for `withSingleDateTag` / `normalizeSmartTags`: `last wins` only
 * applies to tags that are still semantically "active" date tags.
 */
export function isSmartDateTag(tag: string, now: Date = new Date()): boolean {
  const fn = smartFunctionalityOfTag(tag, now);
  if (fn === null) return false;
  return (
    fn === 'today' ||
    fn === 'yesterday' ||
    fn === 'tomorrow' ||
    fn === 'nextWeek' ||
    fn === 'now' ||
    fn === 'currentMonth' ||
    fn === 'currentYear'
  );
}

/**
 * One date tag per file: keep the newest date-shaped tag (any of the 7
 * date functionalities, fresh OR stale, with or without legacy prefix),
 * drop earlier ones. Uses `isAnyDateShapeTag` — broader than
 * `isSmartDateTag` — so an active `today` plus a stale `month-202606`
 * collapse to the last-applied one, instead of co-existing.
 *
 * Period tags (`YYYYMMDD-YYYYMMDD`) are an independent互斥 family and
 * pass through here — they have their own `withSinglePeriodTag`.
 *
 * Predicates: `isAnyDateShapeTag` is the *broader* predicate also used by
 * the Phase-4 migration's互斥 path, so behavior here matches.
 */
export function withSingleDateTag(tags: string[], now: Date = new Date()): string[] {
  return withSingleFrom(tags, isAnyDateShapeTag);
}

/**
 * One period tag per file: keep the newest `YYYYMMDD-YYYYMMDD` tag, drop
 * earlier ones. Periods are an independent exclusive family from the smart
 * date family (see docs/03-tagging.md §5) — a file can carry one of each.
 */
export function withSinglePeriodTag(tags: string[]): string[] {
  return withSingleFrom(tags, isPeriodTag);
}

/**
 * True when `tag` is a date-shaped tag (any of the 7 smart date functionalities,
 * with or without the legacy template prefix) that is currently STALE — i.e.
 * NOT within any of the 7 freshness windows at `now`. Period tags
 * (`YYYYMMDD-YYYYMMDD`) are explicitly excluded: they have their own fold
 * (`period:`) and don't count toward the `日期` chip.
 *
 * Used by the tag library to aggregate stale date tags into a single
 * `日期` chip (Phase 3 / §8) — distinct from the active `smart:<fn>` chips
 * and from the period fold.
 */
export function isStaleDateTag(tag: string, now: Date = new Date()): boolean {
  if (isPeriodTag(tag)) return false;
  if (normalizeDateTag(tag) === null) return false;
  return smartFunctionalityOfTag(tag, now) === null;
}

/**
 * True when `tag` matches any date-family shape — independent of freshness.
 * Distinct from `isSmartDateTag` (which requires the tag to be currently fresh)
 * and `isStaleDateTag` (which requires the tag to be currently stale): this
 * helper is the union, used by the Phase-4 one-shot migration to dedupe
 * multiple date-shaped tags on a file when the user has ambiguous legacy data
 * (e.g. both a stale `today-20251223` and a stale `month-202512` after
 * prefix-stripping — we collapse to the most recent one regardless of
 * whether either is currently active).
 *
 * Period tags are excluded — they have their own exclusive family.
 */
export function isAnyDateShapeTag(tag: string): boolean {
  if (isPeriodTag(tag)) return false;
  return normalizeDateTag(tag) !== null;
}

/**
 * Applies every "at most one" smart-tag rule a file's tag list must satisfy
 * (rating + workflow + quadrant + date + period). Call this at each save path
 * so the invariants are enforced in one place regardless of how the tags were
 * assembled. Date freshness is checked against `new Date()` here; the
 * alternate `normalizeSmartTagsAt` (when one exists) lets tests pass an
 * explicit `now`.
 */
export function normalizeSmartTags(tags: string[]): string[] {
  return withSinglePeriodTag(
    withSingleDateTag(
      withSingleQuadrant(withSingleWorkflow(withSingleRating(tags)))
    )
  );
}

/**
 * i18n key for a smart tag's display label (e.g. 'today' -> 'smartTagToday').
 * The `functionality` is the stable identity; the `title` field is only an
 * English fallback. Display sites should render `t(smartTagI18nKey(fn))` so the
 * label follows the active language. Stored tag VALUES are unaffected — they
 * come from `resolveSmartTag`, which never reads the title.
 */
export function smartTagI18nKey(fn: SmartFunctionality): string {
  return `smartTag${fn.charAt(0).toUpperCase()}${fn.slice(1)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** YYYYMMDD in the host's local timezone. */
function ymd(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** HHMM (24h, local). */
function hm(d: Date): string {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/**
 * H.25 P2-3: Monday of the ISO week containing `d` (Mon=0..Sun=6). Used by
 * `resolveSmartTag('nextWeek', ...)` to produce a stable `week-YYYYMMDD`
 * token representing "the week that contains the day 7 days from now". We
 * jump `+7` first so the user asking on Sunday gets *next* Monday, not the
 * current one — `addDays(now, 7)` lands on the same day next week, then
 * `mondayOfWeek` snaps to its week's Monday.
 */
export function mondayOfWeek(d: Date): Date {
  // JS getDay: Sun=0..Sat=6. We want Mon=0..Sun=6.
  const dow = (d.getDay() + 6) % 7;
  return addDays(d, -dow);
}

/**
 * Resolves a smart tag to its concrete string value at the given moment.
 *
 * `now` is passed in (not read via `new Date()` internally) so the function
 * stays pure and testable — callers pass `new Date()` at the drop/click site.
 * Returns null for an unknown functionality (callers fall back to the raw title).
 *
 * Storage form (post §1): templates prefixes have been dropped — the stored
 * value IS the date itself, in compact form:
 *   `now`         → `YYYYMMDDTHHMM`   (e.g. `20260704T1430`)
 *   `today`       → `YYYYMMDD`         (e.g. `20260704`)
 *   `yesterday`   → `YYYYMMDD`
 *   `tomorrow`    → `YYYYMMDD`
 *   `nextWeek`    → `YYYYMMDD`         (the Monday of next week)
 *   `currentMonth`→ `YYYYMM`           (e.g. `202607`)
 *   `currentYear` → `YYYY`             (e.g. `2026`)
 *
 * The legacy `today-YYYYMMDD` / `week-YYYYMMDD` / `month-YYYYMM` / `year-YYYY`
 * / `now-YYYYMMDDTHHMM` forms continue to be parsed by `smartFunctionalityOfTag`
 * until Phase 4 migration rewrites them.
 */
export function resolveSmartTag(
  fn: SmartFunctionality,
  now: Date
): string | null {
  // Workflow states resolve to their stored token (`workflowInProgress` ->
  // `in-progress`); handled here so the switch stays focused on time/ratings.
  const workflowValue = WORKFLOW_VALUE_BY_FN.get(fn);
  if (workflowValue) return workflowValue;
  // Quadrant tags likewise resolve to their fixed token.
  const quadrantValue = QUADRANT_VALUE_BY_FN.get(fn);
  if (quadrantValue) return quadrantValue;
  switch (fn) {
    case 'now':
      return `${ymd(now)}T${hm(now)}`;
    case 'today':
      return ymd(now);
    case 'yesterday':
      return ymd(addDays(now, -1));
    case 'tomorrow':
      return ymd(addDays(now, 1));
    case 'nextWeek':
      // +7 first → same weekday next week, then snap to its Monday. Going
      // straight to `mondayOfWeek(now)` would return the current week when
      // the user is on/before Wednesday — the explicit +7 makes the
      // semantics "the Monday of the week *after* this one" unambiguous.
      return ymd(mondayOfWeek(addDays(now, 7)));
    case 'currentMonth':
      return `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;
    case 'currentYear':
      return `${now.getFullYear()}`;
    case 'star1':
    case 'star2':
    case 'star3':
    case 'star4':
    case 'star5':
      // Ratings are constant (no date) — `star3` -> `3star`, matching TagSpaces.
      return `${ratingOfFunctionality(fn)}star`;
    default:
      return null;
  }
}

/**
 * Normalize a date-shape tag (legacy or new) to its canonical compact form.
 * Returns null if `tag` doesn't look like any of the 7 date functionalities.
 *
 *   `today-20260704`    → `20260704`
 *   `20260704`          → `20260704`
 *   `yesterday-...`     → `YYYYMMDD`
 *   `tomorrow-...`      → `YYYYMMDD`
 *   `week-20260713`     → `20260713`           (nextWeek: day-resolution)
 *   `month-202607`      → `202607`             (currentMonth: month-resolution)
 *   `year-2026`         → `2026`               (currentYear: year-resolution)
 *   `now-20260704T1430` → `20260704T1430`
 *   `20260704T1430`     → `20260704T1430`
 *   `20260704-20260710` → null                 (period, not a smart tag)
 *   `idea`              → null
 *
 * Used by `smartFunctionalityOfTag` to compare against the freshly-resolved
 * value from `resolveSmartTag(fn, now)` — equal canonical strings ⇒ fresh.
 */
/**
 * True when `tag` matches a `SmartFunctionality` enum value (any of the
 * 7 date / 5 rating / 5 workflow / 4 quadrant values, including both the
 * function names like `today` and the resolved tokens like `in-progress`).
 * Used by `resolveInputTag` to decide whether a user-typed string in the
 * chip input should be resolved via `resolveSmartTag` before storage.
 */
export function isSmartFunctionalityName(tag: string): boolean {
  if (SMART_TAGS.some((d) => d.title === tag || d.functionality === tag)) return true;
  if (RATING_TAGS.some((d) => d.title === tag || d.functionality === tag)) return true;
  if (WORKFLOW_DEFS.some((d) => d.value === tag || d.functionality === tag)) return true;
  if (QUADRANT_DEFS.some((d) => d.value === tag || d.functionality === tag)) return true;
  return false;
}

/**
 * Strip the legacy template prefix from a date tag, returning the canonical
 * compact form (`20260704` / `202606` / `2026` / `20260704T1430`). Returns
 * `null` if `tag` doesn't look like any of the 7 date functionalities (in
 * either prefix or compact form) — callers use this to decide whether to
 * treat `tag` as a date-shaped input that needs互斥 / prefix-stripping.
 *
 * Exported because `addTag` in PropertiesTray needs to resolve user-typed
 * prefix forms (`month-202606`) to compact form on the way in. The
 * Phase-4 migration has its own private copy of this regex chain.
 */
export function normalizeDateTag(tag: string): string | null {
  // Day-resolution (today / yesterday / tomorrow / nextWeek)
  let m = /^(?:today|yesterday|tomorrow|week)-(\d{8})$/.exec(tag);
  if (m) return m[1];
  m = /^(\d{8})$/.exec(tag);
  if (m) return tag;
  // Month-resolution (currentMonth)
  m = /^month-(\d{6})$/.exec(tag);
  if (m) return m[1];
  m = /^(\d{6})$/.exec(tag);
  if (m) return tag;
  // Year-resolution (currentYear)
  m = /^year-(\d{4})$/.exec(tag);
  if (m) return m[1];
  m = /^(\d{4})$/.exec(tag);
  if (m) return tag;
  // Datetime (now)
  m = /^now-(\d{8}T\d{4})$/.exec(tag);
  if (m) return m[1];
  m = /^(\d{8}T\d{4})$/.exec(tag);
  if (m) return tag;
  return null;
}

/**
 * Resolve a user-typed string from the chip input to its stored form:
 *   1. If `tag` is a `SmartFunctionality` value (`today`, `tomorrow`,
 *      `in-progress`, `urgent-important`, etc.), resolve via
 *      `resolveSmartTag` to the compact storage form.
 *   2. Otherwise, if `tag` is a prefix-form date tag (`month-202606`,
 *      `today-20260704`), strip the prefix via `normalizeDateTag`.
 *   3. Otherwise, return `tag` unchanged (a plain user tag like `vacation`).
 *
 * Used by `addTag` in PropertiesTray so that typing `today` resolves to
 * `20260704` and typing `month-202606` resolves to `202606` — the
 * resulting compact form is then a candidate for互斥 via
 * `normalizeSmartTags`.
 */
export function resolveInputTag(tag: string, now: Date = new Date()): string {
  if (isSmartFunctionalityName(tag)) {
    return resolveSmartTag(tag as SmartFunctionality, now) ?? tag;
  }
  return normalizeDateTag(tag) ?? tag;
}

/**
 * Inverse of resolveSmartTag: given a concrete tag, detect whether it's a
 * smart-tag value (e.g. "20260704" new-form, "today-20260627" legacy form,
 * "3star", "in-progress") and return its functionality.
 *
 * `now` is **optional** and defaults to `new Date()`. When supplied, the date
 * family (today / yesterday / tomorrow / nextWeek / now / currentMonth /
 * currentYear) is checked against a freshness window: the canonical compact
 * form of `tag` must equal what `resolveSmartTag(fn, now)` produces today.
 * Otherwise the function returns null and the tag is treated as a stale
 * date stamp (the `日期` fold chip takes over in the tag library — see
 * docs/03-tagging.md §3).
 *
 * Workflow / rating / quadrant are time-independent and unaffected by `now`.
 * The old prefixed forms (`today-...`, `week-...`, `month-...`, `year-...`,
 * `now-...`) are still parsed so legacy sidecars (pre-Phase-4-migration) keep
 * working; they go through the same freshness check.
 *
 * Used to fold variants back together in the tag library (so timestamped time
 * tags don't flood it, and ratings/workflow get their accent color + localized
 * label). Patterns are STRICT — `month-report` is NOT mistaken for a smart tag.
 */
export function smartFunctionalityOfTag(
  tag: string,
  now: Date = new Date()
): SmartFunctionality | null {
  // Time-independent families first.
  const star = /^([1-5])star$/.exec(tag);
  if (star) return `star${star[1]}` as SmartFunctionality;
  const wfFn = WORKFLOW_FN_BY_VALUE.get(tag);
  if (wfFn) return wfFn;
  const quadrantFn = QUADRANT_FN_BY_VALUE.get(tag);
  if (quadrantFn) return quadrantFn;

  // Date family with freshness check: the canonical compact form of `tag`
  // must equal the value `resolveSmartTag` produces now. If it doesn't,
  // return null (stale — fold chip in TagLibrary / raw elsewhere).
  const canonical = normalizeDateTag(tag);
  if (canonical === null) return null;
  for (const fn of [
    'today',
    'yesterday',
    'tomorrow',
    'nextWeek',
    'now',
    'currentMonth',
    'currentYear',
  ] as const) {
    if (resolveSmartTag(fn, now) === canonical) return fn;
  }
  return null;
}
