#!/usr/bin/env ts-node
/**
 * Locale key-consistency check.
 *
 * Compares every `src/renderer/locales/<lng>/common.json` against the `en`
 * baseline and fails on:
 *   1. missing keys (untranslated → i18next would silently render the raw key
 *      or fall back to English)
 *   2. extra keys (stale keys left behind after an en rename/removal)
 *   3. interpolation placeholder drift (`{{name}}` present in en but not in
 *      the translation — would render a broken string at runtime)
 *
 * Plural keys (`foo_one` / `foo_other` / ...) are resolved per target
 * language via `Intl.PluralRules`: a language whose only plural category is
 * `other` (ja, ko, zh-TW) needs just `foo_other`; a language with more
 * categories (ru, ar) needs one variant per category that the baseline
 * defines, plus `_other` as the universal fallback.
 *
 * Runs as part of `npm test` — the runner auto-discovers scripts/**\/*.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../src/renderer/locales');
const BASELINE = 'en';

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

interface FlatLocale {
  /** Non-plural keys plus plural base names (suffix stripped). */
  keys: Set<string>;
  /** base name -> set of plural categories present in the file. */
  plurals: Map<string, Set<string>>;
  raw: Record<string, string>;
}

function loadLocale(lng: string): FlatLocale {
  const file = path.join(LOCALES_DIR, lng, 'common.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    string
  >;
  const keys = new Set<string>();
  const plurals = new Map<string, Set<string>>();
  for (const key of Object.keys(raw)) {
    const suffix = PLURAL_SUFFIXES.find((s) => key.endsWith(`_${s}`));
    if (suffix) {
      const base = key.slice(0, -(suffix.length + 1));
      if (!plurals.has(base)) plurals.set(base, new Set());
      plurals.get(base)!.add(suffix);
    } else {
      keys.add(key);
    }
  }
  return { keys, plurals, raw };
}

/** Plural categories a language can actually select (e.g. ja → ['other']). */
function pluralCategories(lng: string): Set<string> {
  return new Set(new Intl.PluralRules(lng).resolvedOptions().pluralCategories);
}

/** `{{var}}` placeholders in an i18next value. */
function placeholders(value: string): Set<string> {
  const out = new Set<string>();
  const re = /\{\{\s*([^}\s]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out.add(m[1]);
  return out;
}

const baseline = loadLocale(BASELINE);
const targetLngs = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== BASELINE)
  .map((d) => d.name)
  .sort();

assert.ok(targetLngs.length > 0, 'no target locales found next to en/');

// Self-check the en baseline so a missing plural form is caught HERE instead
// of silently propagating to every target (the per-target checks below only
// compare targets against the baseline — a baseline gap is invisible to them).
// English selects `one` + `other`, so every pluralized count-key must define
// both. This would have caught `ganttLaneHidden` shipping with only `_other`
// (plus a bare fallback that masked it).
test('locale en baseline: plural bases cover all en plural categories', () => {
  const enCats = pluralCategories(BASELINE);
  const problems: string[] = [];
  for (const [base, baseCats] of baseline.plurals) {
    for (const c of enCats) {
      if (!baseCats.has(c)) {
        problems.push(
          `${base}: missing _${c} (en plural categories are ${[...enCats]
            .sort()
            .join('/')})`
        );
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// Regression guard for the v3-era `(s)` singular/plural shorthand that the
// i18next v4 migration eliminated. A value like "{{count}} file(s)" should be
// split into `_one`/`_other`. Low false-positive risk: `(s)` is not used for
// anything but the count singular/plural trick.
test('locale en baseline: no "(s)" plural shorthand left in values', () => {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(baseline.raw)) {
    if (/\(s\)/.test(value)) {
      problems.push(
        `${key}: value uses "(s)" — split into _one/_other plural forms`
      );
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// i18next reserves some option keys (`lng`, `ns`, ...) — using them as
// interpolation placeholders collides: a caller passing `{ lng: <value> }`
// makes i18next treat the value as the LANGUAGE (not an interpolation var)
// and crashes (e.g. `{{lng}}` for longitude → `TypeError: lng.toLowerCase`).
// `confirmTagLocation` hit this; placeholder renamed to `{{lon}}`. Scan every
// locale (not just en): the placeholder-parity check below only ensures
// targets have en's placeholders, not that they lack extras of their own.
test('all locales: no i18next-reserved option key (lng/ns) used as placeholder', () => {
  const reserved = ['lng', 'ns'];
  const problems: string[] = [];
  for (const lng of [BASELINE, ...targetLngs]) {
    const { raw } = loadLocale(lng);
    for (const [key, value] of Object.entries(raw)) {
      for (const r of reserved) {
        if (value.includes(`{{${r}}}`) || value.includes(`{{ ${r} }}`)) {
          problems.push(
            `${lng}/${key}: reserved i18next option key {{${r}}} as placeholder — rename (e.g. {{lon}} for longitude)`
          );
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

for (const lng of targetLngs) {
  test(`locale ${lng}: keys match ${BASELINE} baseline`, () => {
    const target = loadLocale(lng);
    const cats = pluralCategories(lng);
    const problems: string[] = [];

    // Non-plural keys must match exactly.
    for (const key of baseline.keys) {
      if (!target.keys.has(key)) problems.push(`missing key: ${key}`);
    }
    for (const key of target.keys) {
      if (!baseline.keys.has(key)) problems.push(`extra key: ${key}`);
    }

    // Plural bases: target needs every baseline category that its language
    // can select, plus `_other` (universal i18next fallback).
    for (const [base, baseCats] of baseline.plurals) {
      const have = target.plurals.get(base);
      if (!have) {
        problems.push(`missing plural key: ${base}_other`);
        continue;
      }
      const required = new Set([...baseCats].filter((c) => cats.has(c)));
      required.add('other');
      for (const c of required) {
        if (!have.has(c)) problems.push(`missing plural key: ${base}_${c}`);
      }
      // Categories the language never selects are dead weight (e.g. ja `_one`).
      for (const c of have) {
        if (!cats.has(c)) {
          problems.push(`unused plural variant: ${base}_${c} (never selected for ${lng})`);
        }
      }
    }

    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test(`locale ${lng}: interpolation placeholders preserved`, () => {
    const target = loadLocale(lng);
    const problems: string[] = [];
    for (const [key, enValue] of Object.entries(baseline.raw)) {
      const value = target.raw[key];
      if (typeof value !== 'string') continue; // missing keys reported above
      const want = placeholders(enValue);
      const got = placeholders(value);
      for (const p of want) {
        if (!got.has(p)) problems.push(`${key}: missing placeholder {{${p}}}`);
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });
}
