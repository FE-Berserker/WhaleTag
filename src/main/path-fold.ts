import path from 'path';
import { realpathSync } from 'fs';
import {
  foldPath as applyCasePolicy,
  isCaseInsensitivePlatform,
  isSameOrDescendantPath as isSameOrDescendantPathWithPolicy,
} from '../shared/path-fold';

export { isCaseInsensitivePlatform };

/**
 * Main-process case policy for the security boundary checks (`allowed-roots`
 * write confinement + `extension-protocol` traversal guard) and the
 * external-change watcher. The platform reasoning lives in
 * `src/shared/path-fold.ts`: Windows/macOS fold, Linux/other compare exactly.
 */
export const CASE_INSENSITIVE_FS = isCaseInsensitivePlatform(process.platform);

/**
 * Lowercase on Windows/macOS, identity on Linux/other. The `caseInsensitive`
 * param is a test seam so both branches can be exercised off-platform.
 */
export function foldPath(
  p: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): string {
  return applyCasePolicy(p, caseInsensitive);
}

/**
 * True when `candidate` equals `ancestor` or sits beneath it (either slash
 * style, segment-boundary aware). Case follows the same platform policy as
 * {@link foldPath}; the third parameter is the test seam.
 */
export function isSameOrDescendantPath(
  ancestor: string,
  candidate: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): boolean {
  return isSameOrDescendantPathWithPolicy(ancestor, candidate, caseInsensitive);
}

/**
 * One key for every spelling of the same filesystem target — absolute,
 * case-folded, and (when the target or at least its parent exists) resolved
 * through the real path, so symlink / junction aliases share the key too.
 *
 * Used wherever in-process queues are keyed by path: the per-directory
 * sidecar lock (`dir-lock.ts`) and the per-target write serialization
 * (`atomic-write.ts`). Without the real-path step a location opened through
 * a junction and the same location opened by its real path get two queues,
 * and two read-modify-write cycles on one `wsd.json` overlap (lost update).
 *
 * Sync by design (one `realpath`, ~30 µs) and never throws: an unusable
 * target degrades to the plain folded spelling.
 */
export function canonicalPathKey(target: string): string {
  let resolved: string;
  try {
    resolved = path.resolve(target);
  } catch {
    return foldPath(target);
  }
  try {
    return foldPath(realpathSync(resolved));
  } catch {
    // The target usually does not exist yet on its first write. Canonicalize
    // the parent directory instead: `D:\link\wsd.json` and `D:\real\wsd.json`
    // then still map to one key when `link` is a symlink to `real`.
    try {
      return foldPath(
        path.join(realpathSync(path.dirname(resolved)), path.basename(resolved))
      );
    } catch {
      return foldPath(resolved);
    }
  }
}
