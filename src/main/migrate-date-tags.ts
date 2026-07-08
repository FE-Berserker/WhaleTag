/**
 * One-shot migration for the smart-tag storage form (Phase 4 of plan §8):
 *
 *   1. Strip legacy template prefixes (`today-YYYYMMDD` → `YYYYMMDD`,
 *      `now-YYYYMMDDTHHMM` → `YYYYMMDDTHHMM`, `month-YYYYMM` → `YYYYMM`,
 *      `year-YYYY` → `YYYY`).
 *   2. Apply互斥 family convergence: keep at most ONE date-shaped tag
 *      (`isAnyDateShapeTag`) and at most ONE period tag
 *      (`isPeriodTag`) on a file — the last one wins. Stale tags are
 *      collapsed here too (the read-time互斥 in `normalizeSmartTags` uses
 *      `isSmartDateTag`, which is freshness-aware; the migration uses the
 *      broader `isAnyDateShapeTag` because the user explicitly said
 *      "如遇到多个日期标签,保留其中一个就行" — keep one regardless of
 *      freshness).
 *   3. First-run backup of every modified `<file>` to `<file>.bak-dateprefix`,
 *      gated by a flag in `.whale/_migration-state.json` so subsequent runs
 *      skip the backup and become pure idempotent rewrites.
 *
 * Trigger: app startup (`runMigration(allowedRoots)` in main.ts). Per-file
 * writes are wrapped in `withLock` + `atomicWriteJson`; one file's failure
 * does not abort the rest of the migration.
 *
 * Idempotency: a second pass over an already-migrated file finds nothing to
 * change — the prefix-strip regex doesn't match the bare form, the互斥
 * function is stable on a 0-or-1-element date set, and the resulting tags
 * array deep-equals the input.
 *
 * File layout assumed:
 *   - `<dir>/.whale/wsd.json` — AggregatedSidecar, see `sidecar.ts`
 *   - `<dir>/.whale/wsm.json` — folder metadata, see `folder-meta.ts`
 *   - `<allowedRoot>/.whale/_migration-state.json` — global flag, lives
 *     once per location root (in the root's `.whale/`).
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { META_DIR, FOLDER_SIDECAR_FILE, FOLDER_META_FILE } from '../shared/whale-meta';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';
import {
  isAnyDateShapeTag,
  isPeriodTag,
  withSingleFrom,
} from '../shared/smart-tags';

/** Strip the legacy 7 prefixes (`today` / `yesterday` / `tomorrow` / `now` /
 *  `week` / `month` / `year`) and return the bare compact form. Returns
 *  `tag` unchanged when no prefix matches. */
function stripLegacyPrefix(tag: string): string {
  const m = /^(?:today|yesterday|tomorrow|now|week|month|year)-(\S+)$/.exec(tag);
  return m ? m[1] : tag;
}

/**
 * Pure: transform a single tag list per the migration rules.
 * Returns the new tag list and a `changed` flag the caller can use to skip
 * the atomic write (no-op idempotency on already-migrated data).
 */
export function migrateSidecarTags(tags: string[]): {
  tags: string[];
  changed: boolean;
} {
  if (!Array.isArray(tags)) return { tags, changed: false };
  const stripped = tags.map(stripLegacyPrefix);
  // Date-shaped dedup uses the broad `isAnyDateShapeTag` so stale + active
  // values converge together; period dedup uses `isPeriodTag`. Both are
  // last-wins (matches the existing `withSingleFrom` semantics).
  const withDate = withSingleFrom(stripped, isAnyDateShapeTag);
  const withBoth = withSingleFrom(withDate, isPeriodTag);
  // Deep-equal check via JSON (cheap, no deps, arrays of strings).
  const changed = JSON.stringify(withBoth) !== JSON.stringify(tags);
  return { tags: withBoth, changed };
}

/** Aggregate summary returned by `runMigration` for the caller's logs. */
export interface MigrationResult {
  totalScanned: number;
  totalMigrated: number;
  totalBackups: number;
  totalSkipped: number;
  totalErrors: number;
  errors: { path: string; message: string }[];
}

const MIGRATION_STATE_FILE = '_migration-state.json';
const MIGRATION_FLAG = 'date-prefix-v1';
const BACKUP_SUFFIX = '.bak-dateprefix';

interface MigrationState {
  [key: string]: unknown;
  [MIGRATION_FLAG]?: boolean;
}

/** Read the global migration flag from `<root>/.whale/_migration-state.json`.
 *  Returns `{}` (no flag) when the file doesn't exist or is corrupt. */
async function readMigrationState(root: string): Promise<MigrationState> {
  const statePath = path.join(root, META_DIR, MIGRATION_STATE_FILE);
  try {
    const buf = await fsp.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(buf);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as MigrationState)
      : {};
  } catch {
    return {};
  }
}

/** Persist the global migration flag. Idempotent. */
async function writeMigrationState(
  root: string,
  state: MigrationState
): Promise<void> {
  const statePath = path.join(root, META_DIR, MIGRATION_STATE_FILE);
  const tmp = `${statePath}.tmp`;
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await fsp.rename(tmp, statePath);
}

/** Recursively yield every directory under `root` (including root itself). */
async function* walkDirs(root: string): AsyncIterable<string> {
  yield root;
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === META_DIR) continue; // skip `.whale/`
    // Skip symlinks to avoid cycles. We don't follow them for migration.
    if (ent.isSymbolicLink()) continue;
    yield* walkDirs(path.join(root, ent.name));
  }
}

interface FileMigrationReport {
  scanned: number;
  migrated: number;
  backups: number;
  errors: { path: string; message: string }[];
}

/** Migrate a single sidecar file. Returns counts for the summary. */
async function migrateSidecarFile(
  filePath: string,
  flag: MigrationState
): Promise<FileMigrationReport> {
  const report: FileMigrationReport = {
    scanned: 0,
    migrated: 0,
    backups: 0,
    errors: [],
  };
  const dir = path.dirname(filePath); // `<dir>/.whale`
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Corrupt JSON — skip; the user has bigger problems and we don't
      // want to overwrite their data with a partial migration.
      report.errors.push({
        path: filePath,
        message: `JSON.parse failed: ${(err as Error).message}`,
      });
      return report;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      // Not the expected object shape — skip silently.
      return report;
    }
    const obj = parsed as { files?: Record<string, { tags?: string[] }> };
    if (!obj.files) {
      // No `files` map (e.g. wsm.json has a different shape — handled
      // separately in migrateFolderMeta). Nothing to do here.
      return report;
    }
    let changed = false;
    for (const filename of Object.keys(obj.files)) {
      const entry = obj.files[filename];
      if (!entry || !Array.isArray(entry.tags)) continue;
      report.scanned += 1;
      const r = migrateSidecarTags(entry.tags);
      if (r.changed) {
        entry.tags = r.tags;
        changed = true;
      }
    }
    if (changed) {
      // Per-directory lock for safe write under concurrent batch tagging.
      await withLock(path.dirname(dir), async () => {
        if (!flag[MIGRATION_FLAG]) {
          await fsp.copyFile(filePath, `${filePath}${BACKUP_SUFFIX}`);
          report.backups += 1;
        }
        await atomicWriteJson(filePath, parsed);
        report.migrated += 1;
      });
    }
  } catch (err) {
    report.errors.push({
      path: filePath,
      message: (err as Error).message,
    });
  }
  return report;
}

/**
 * Migrate the folder-meta file (`.whale/wsm.json`). Its shape is a single
 * object with `tags` and other fields (not a `files` map), so we apply
 * `migrateSidecarTags` directly to its `tags` array.
 */
async function migrateFolderMetaFile(
  filePath: string,
  flag: MigrationState
): Promise<FileMigrationReport> {
  const report: FileMigrationReport = {
    scanned: 0,
    migrated: 0,
    backups: 0,
    errors: [],
  };
  const dir = path.dirname(filePath);
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      report.errors.push({
        path: filePath,
        message: `JSON.parse failed: ${(err as Error).message}`,
      });
      return report;
    }
    if (typeof parsed !== 'object' || parsed === null) return report;
    const obj = parsed as { tags?: string[] };
    if (!Array.isArray(obj.tags)) return report;
    report.scanned += 1;
    const r = migrateSidecarTags(obj.tags);
    if (!r.changed) return report;
    obj.tags = r.tags;
    await withLock(path.dirname(dir), async () => {
      if (!flag[MIGRATION_FLAG]) {
        await fsp.copyFile(filePath, `${filePath}${BACKUP_SUFFIX}`);
        report.backups += 1;
      }
      await atomicWriteJson(filePath, parsed);
      report.migrated += 1;
    });
  } catch (err) {
    report.errors.push({
      path: filePath,
      message: (err as Error).message,
    });
  }
  return report;
}

/**
 * Run the migration across every location root. Background-friendly: never
 * throws, returns a structured summary the caller can log. Designed to be
 * invoked once per app start, after `app.whenReady` and after settings
 * have been loaded (so `allowedRoots` is populated).
 */
export async function runMigration(
  allowedRoots: string[]
): Promise<MigrationResult> {
  const result: MigrationResult = {
    totalScanned: 0,
    totalMigrated: 0,
    totalBackups: 0,
    totalSkipped: 0,
    totalErrors: 0,
    errors: [],
  };
  if (!allowedRoots || allowedRoots.length === 0) return result;

  // Process each location root independently. The flag is per-root, so a
  // user with multiple locations gets backup-once per location.
  for (const root of allowedRoots) {
    const flag = await readMigrationState(root);
    for await (const dir of walkDirs(root)) {
      const wsdPath = path.join(dir, META_DIR, FOLDER_SIDECAR_FILE);
      const wsmPath = path.join(dir, META_DIR, FOLDER_META_FILE);
      const [wsd, wsm] = await Promise.all([
        fsp
          .access(wsdPath)
          .then(() => migrateSidecarFile(wsdPath, flag))
          .catch(() => null),
        fsp
          .access(wsmPath)
          .then(() => migrateFolderMetaFile(wsmPath, flag))
          .catch(() => null),
      ]);
      for (const rep of [wsd, wsm].filter(Boolean) as FileMigrationReport[]) {
        result.totalScanned += rep.scanned;
        result.totalMigrated += rep.migrated;
        result.totalBackups += rep.backups;
        result.totalErrors += rep.errors.length;
        result.errors.push(...rep.errors);
      }
    }
    // After the first pass over this root, persist the flag so subsequent
    // runs skip the backup. Even an all-skipped pass is fine to mark — the
    // next run will also skip the backup (idempotent).
    if (!flag[MIGRATION_FLAG]) {
      try {
        await writeMigrationState(root, { ...flag, [MIGRATION_FLAG]: true });
      } catch (err) {
        result.errors.push({
          path: path.join(root, META_DIR, MIGRATION_STATE_FILE),
          message: `failed to write migration flag: ${(err as Error).message}`,
        });
        result.totalErrors += 1;
      }
    }
  }
  return result;
}
