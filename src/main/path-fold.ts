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
