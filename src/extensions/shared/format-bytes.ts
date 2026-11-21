/**
 * Human-readable byte sizes shared by the bundled extension viewers.
 *
 * Each viewer used to carry its own copy (font / html / text; json had an
 * unguarded variant). They all render the same four thresholds, so this lives
 * in one module — the extension bundle resolves it through the same relative
 * import the other `shared/*` helpers use.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
