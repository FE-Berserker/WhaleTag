/**
 * json-viewer pure helpers.
 *
 * DOM-free logic so it can be unit-tested under `node:test` (see
 * json-model.test.ts). The interactive tree rendering itself lives in
 * index.ts because it manipulates the DOM.
 */

export type PathSegment = string | number;

/** Aggregate stats over a parsed JSON value, shown in the status bar. */
export interface TreeStats {
  /** Total number of values in the tree, including the root and every
   *  primitive / container. */
  nodes: number;
  /** Deepest nesting level (root object/array counts as depth 1). */
  depth: number;
}

/** True for the two JSON container kinds (object / array). */
export function isContainer(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

/**
 * Count total nodes and maximum nesting depth in one walk.
 * The root value is node #1 at depth 1; primitives contribute a node but no
 * extra depth.
 */
export function computeStats(value: unknown): TreeStats {
  let nodes = 0;
  let maxDepth = 0;

  function walk(v: unknown, depth: number): void {
    nodes += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        walk((v as Record<string, unknown>)[key], depth + 1);
      }
    }
  }

  walk(value, 1);
  return { nodes, depth: maxDepth };
}

/** A key is "simple" if it can follow a dot without brackets in a JSONPath. */
export function isSimpleKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/**
 * Format a chain of path segments as a JSONPath-ish string.
 *   []                    → "$"
 *   ['users', 0, 'name']  → "$.users[0].name"
 *   ['odd key']           → "$['odd key']"
 */
export function formatPath(segments: PathSegment[]): string {
  let out = '$';
  for (const seg of segments) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (isSimpleKey(seg)) {
      out += `.${seg}`;
    } else {
      out += `['${seg.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
    }
  }
  return out;
}

/**
 * One-line collapsed summary for a container, e.g. `3 items` / `1 key`.
 * `count` is the number of direct children.
 */
export function summarize(value: unknown, count: number): string {
  if (Array.isArray(value)) {
    return count === 1 ? '1 item' : `${count} items`;
  }
  return count === 1 ? '1 key' : `${count} keys`;
}

/** Pretty-print with 2-space indent; returns the input untouched on failure. */
export function toPretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Compact single-line form. */
export function toMinified(value: unknown): string {
  return JSON.stringify(value);
}
