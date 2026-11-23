#!/usr/bin/env ts-node
/**
 * Dead-locale-key guard.
 *
 * `check-locales.test.ts` guarantees that every key the source *asks for*
 * exists in `en/common.json`. This test guards the other direction: every key
 * in `en/common.json` must actually be asked for somewhere — otherwise the
 * locale files accumulate stale strings (P3-6 deleted 50 of them; `docs/19`
 * tracks the cleanup). Without a guard, the next rename/removal silently
 * leaves the old key behind and translating 5 locales keeps paying for it.
 *
 * Detection: a key counts as used when its exact name appears as a quoted
 * string literal in non-test `src/**` source. That covers the obvious
 * `t('key')` / `i18n.t('key')` / `t('key', { defaultValue })` calls *and*
 * indirection tables that hold keys as data (`labelKey: 'key'`, `<Trans
 * i18nKey="key">`, arrays of menu definitions) which a `t(...)`-only scanner
 * would report as dead. Plural suffixes are ignored: a plural base `foo` is
 * detected via the `t('foo', { count })` call site, so `_one`/`_other` rows
 * need no separate scan.
 *
 * Dynamic keys cannot be seen statically. Every `t(`...${...}`)` prefix is
 * listed in `DYNAMIC_KEY_PATTERNS` with the source evidence it comes from;
 * the evidence is asserted to still exist so the allowlist cannot rot into a
 * blanket "anything matches" silence.
 *
 * `PENDING_CLEANUP` is a debt list: keys that are provably unreferenced but
 * could not be removed in the guard's change (appearance / themePreset / home
 * / confirmTagLocation_*) — they were masked by same-named identifiers
 * (`settings.themePreset`, the `appearance` reducer module, CSS
 * `appearance:`), which is exactly what this test now catches. Removing the
 * rows requires touching 5 locale files, so it is tracked separately; the
 * list is asserted to stay honest (entry must still exist in `en` AND still
 * be unreferenced).
 *
 * Runs as part of `npm test` — the runner auto-discovers scripts/**\/*.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../src');
const BASELINE_FILE = path.join(SRC_DIR, 'renderer/locales/en/common.json');

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx)$/;
/** Directories whose contents are not UI source (or would self-reference). */
const SKIP_RELATIVE_DIRS = new Set(['renderer/locales']);

/**
 * Keys built at runtime, per call site. `prefix` is everything before the
 * first substituted segment; `evidence` must appear in the scanned source.
 */
const DYNAMIC_KEY_PATTERNS: { prefix: string; evidence: string; reason: string }[] = [
  {
    prefix: 'shape_',
    evidence: 'shape_${shape}',
    reason: "WorkflowManagerDialog renders t(`shape_${shape}`) for the 7 shapes",
  },
  {
    prefix: 'tagShape',
    evidence: 'tagShape${shape[0].toUpperCase()}',
    reason: 'SettingsDialog renders t(`tagShape${capitalized}`) for the 7 shapes',
  },
  {
    prefix: 'smartTag',
    evidence: 'smartTagI18nKey',
    reason: 'shared/smart-tags.ts smartTagI18nKey() builds smartTag<Functionality>',
  },
];

/**
 * Provably-unreferenced keys awaiting a locale-only cleanup commit. Each entry
 * is a logical key; plural bases cover their `_one`/`_other` rows.
 *
 * Empty since the follow-up cleanup deleted `appearance`, `themePreset`,
 * `home` and `confirmTagLocation_*` from all 5 locales. The honesty test below
 * is kept so that a future temporary entry cannot silently rot: an entry must
 * still exist in the en baseline and must still be unreferenced.
 */
const PENDING_CLEANUP: { key: string; why: string }[] = [];

interface Baseline {
  /** Ordinary keys (no plural suffix). */
  keys: Set<string>;
  /** Plural base names (suffix stripped). */
  pluralBases: Set<string>;
}

function loadBaseline(): Baseline {
  const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Record<
    string,
    string
  >;
  const keys = new Set<string>();
  const pluralBases = new Set<string>();
  for (const key of Object.keys(raw)) {
    const suffix = PLURAL_SUFFIXES.find((s) => key.endsWith(`_${s}`));
    if (suffix) pluralBases.add(key.slice(0, -(suffix.length + 1)));
    else keys.add(key);
  }
  return { keys, pluralBases };
}

/**
 * Colocated tests pass arbitrary strings through stub `t` helpers, so they
 * are not evidence of a production reference (a test fixture path like
 * `path.join('home', ...)` would otherwise mask a dead `home` key).
 */
function isTestFile(file: string): boolean {
  return /\.test\.(ts|tsx|js|jsx)$/.test(file);
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(SRC_DIR, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      if (SKIP_RELATIVE_DIRS.has(relative)) continue;
      collectSourceFiles(full, out);
    } else if (
      entry.isFile() &&
      SOURCE_FILE_RE.test(entry.name) &&
      !isTestFile(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

const baseline = loadBaseline();
const sourceFiles = collectSourceFiles(SRC_DIR);

// One pass over the source: string literals are the usage evidence, while the
// joined text lets the allowlist assert its dynamic-construction evidence.
// Keys are flat identifiers (`camelCase`, `shape_rounded`, `settings.x`).
const sourceLiterals = new Set<string>();
const sourceChunks: string[] = [];
const literalRe = /(['"`])([A-Za-z0-9_.:+-]+)\1/g;
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  sourceChunks.push(text);
  let match: RegExpExecArray | null;
  literalRe.lastIndex = 0;
  while ((match = literalRe.exec(text))) sourceLiterals.add(match[2]);
}
const sourceText = sourceChunks.join('\n');

const dynamicPrefixes = DYNAMIC_KEY_PATTERNS.map((pattern) => pattern.prefix);
const pendingKeys = new Set(PENDING_CLEANUP.map((entry) => entry.key));
const logicalKeys = [...baseline.keys, ...baseline.pluralBases];
const logicalKeySet = new Set(logicalKeys);

function isDynamicKey(key: string): boolean {
  return dynamicPrefixes.some((prefix) => key.startsWith(prefix));
}

/** Logical keys in the en baseline that nothing in the source asks for. */
function unreferencedKeys(): string[] {
  return logicalKeys
    .filter((key) => !sourceLiterals.has(key) && !isDynamicKey(key))
    .sort();
}

test('locale guard: every non-dynamic en key is referenced by src source', () => {
  const unused = unreferencedKeys().filter((key) => !pendingKeys.has(key));
  assert.deepEqual(
    unused,
    [],
    [
      'en/common.json keys with no quoted-string reference in non-test src source:',
      ...unused.map((key) => {
        const plural = baseline.pluralBases.has(key) ? ' (plural base)' : '';
        return `  - ${key}${plural}`;
      }),
      'Either wire the key up, or delete it from all 5 locales (and possibly',
      'extend DYNAMIC_KEY_PATTERNS if it is built at runtime).',
    ].join('\n')
  );
});

test('locale guard: dynamic-key allowlist still matches its source evidence', () => {
  const problems: string[] = [];
  for (const pattern of DYNAMIC_KEY_PATTERNS) {
    if (!sourceText.includes(pattern.evidence)) {
      problems.push(
        `${pattern.prefix}*: evidence "${pattern.evidence}" not found in source — remove the allowlist entry or update its evidence (${pattern.reason})`
      );
    }
    const matched = logicalKeys.filter((key) => key.startsWith(pattern.prefix));
    if (matched.length === 0) {
      problems.push(`${pattern.prefix}*: matches no en key — stale allowlist entry (${pattern.reason})`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('locale guard: PENDING_CLEANUP stays honest (key exists, still unreferenced)', () => {
  const problems: string[] = [];
  for (const entry of PENDING_CLEANUP) {
    if (!logicalKeySet.has(entry.key)) {
      problems.push(
        `${entry.key}: listed for cleanup but no longer in en/common.json — drop the entry (${entry.why})`
      );
    } else if (sourceLiterals.has(entry.key) || isDynamicKey(entry.key)) {
      problems.push(
        `${entry.key}: listed for cleanup but is referenced now — remove it from PENDING_CLEANUP (${entry.why})`
      );
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
