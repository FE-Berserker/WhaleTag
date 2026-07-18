/**
 * Pure helpers for the FolderViz directory visualization perspective.
 * React/Electron-free so the tree building and aggregation can be unit-tested
 * in isolation (folderviz.test.ts).
 */

import type { DirEntry } from '../../shared/ipc-types';

export interface FolderVizNode {
  name: string;
  path: string;
  isDirectory: boolean;
  /** Byte size (files = actual; dirs = aggregate of descendants). */
  size: number;
  /** Value channel for ECharts (same as size for dirs, size for files). */
  value: number;
  /** Number of files under this node (recursive). */
  fileCount: number;
  /** Tags attached to this node (files: own tags; dirs: currently empty). */
  tags?: string[];
  children?: FolderVizNode[];
}

export type FolderVizType = 'tree' | 'radial' | 'treemap' | 'sunburst';

/** Separator-tolerant basename. */
function baseNameOf(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Relative path segments from `root` to `target`. Both should be absolute. */
function relativeSegments(root: string, target: string): string[] {
  const rootParts = root.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const targetParts = target.replace(/\\/g, '/').replace(/\/+$/, '').split('/');

  // Find common prefix length.
  let i = 0;
  while (
    i < rootParts.length &&
    i < targetParts.length &&
    rootParts[i].toLowerCase() === targetParts[i].toLowerCase()
  ) {
    i++;
  }

  // On Windows paths are case-insensitive; on POSIX they are not.
  // We tolerate case mismatch because Whale is Windows-primary.
  if (i < rootParts.length) {
    // target is not under root
    return [];
  }

  return targetParts.slice(i).filter(Boolean);
}

/** Build a nested tree from a flat recursive DirEntry list.
 *
 * `maxDepth` limits how many levels below `rootPath` are represented as nodes.
 * Entries deeper than `maxDepth` are skipped.
 *
 * `filter` drops individual entries before they're added to the tree:
 *   - `'all'` (default): keep everything
 *   - `'dir'`: keep only directories �?file entries are dropped
 *   - `'file'`: keep only files �?directory entries are dropped
 * The root node is always present regardless of `filter`. `aggregateTree`
 * still runs at the end, so `value` and `fileCount` on directory nodes
 * reflect only the kept children. */
export type FilterMode = 'all' | 'dir' | 'file';

export function buildTree(
  rootPath: string,
  entries: DirEntry[],
  options: { maxDepth?: number; filter?: FilterMode } = {}
): FolderVizNode {
  const maxDepth = options.maxDepth ?? 3;
  const filter = options.filter ?? 'all';
  const root: FolderVizNode = {
    name: baseNameOf(rootPath) || rootPath,
    path: rootPath,
    isDirectory: true,
    size: 0,
    value: 0,
    fileCount: 0,
  };

  // Pass 1: build the full tree from ALL entries (no filter applied yet).
  // The filter is applied AFTER `aggregateTree` so that directories
  // keep their summed file sizes even when their file children are
  // removed. (ECharts sunburst/treemap render slices proportionally
  // to `value`; if we filtered first then aggregated, every dir's
  // value would be 0 and the chart would be empty. See plan §H.20 F
  // for the rationale �?user feedback 2026-06-30.)
  for (const entry of entries) {
    const segments = relativeSegments(rootPath, entry.path);
    if (segments.length === 0) continue; // skip root itself or out-of-tree
    if (segments.length > maxDepth) continue;

    let current: FolderVizNode | null = root;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!current) break;
      const seg = segments[i];
      if (!current.children) current.children = [];
      let child = current.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: '', // filled below if entry for this dir exists, otherwise stays empty
          isDirectory: true,
          size: 0,
          value: 0,
          fileCount: 0,
        };
        current.children.push(child);
      }
      current = child;
    }
    if (!current) continue;

    const lastSeg = segments[segments.length - 1];
    if (!current.children) current.children = [];
    const existing = current.children.find((c) => c.name === lastSeg);
    if (existing) {
      // A placeholder directory now gets real data, or a duplicate entry.
      existing.path = entry.path;
      existing.isDirectory = entry.isDirectory;
      existing.size = entry.size;
      existing.value = entry.size;
    } else {
      current.children.push({
        name: lastSeg,
        path: entry.path,
        isDirectory: entry.isDirectory,
        size: entry.size,
        value: entry.size,
        fileCount: entry.isDirectory ? 0 : 1,
      });
    }
  }

  // Pass 2: aggregate sizes bottom-up. After this, every directory
  // node has `size` = sum of its descendant file sizes, and
  // `fileCount` = count of descendant files. Even after we filter
  // out files in pass 3, the directories keep these aggregated
  // values so the sunburst/treemap stay proportional.
  aggregateTree(root);

  // Pass 3: apply the filter by removing non-matching children. We
  // do this after aggregation so dir sizes are already baked in.
  // For 'file' filter, removing a directory also removes its file
  // descendants (the file filter says "no dirs", so the dir's
  // children are unreachable) �?files in subdirectories are
  // intentionally not visible in 'file' mode, matching the existing
  // design.
  if (filter !== 'all') {
    const applyFilter = (node: FolderVizNode): void => {
      if (node.children) {
        node.children = node.children.filter((c) => {
          if (filter === 'dir' && !c.isDirectory) return false;
          if (filter === 'file' && c.isDirectory) return false;
          return true;
        });
        for (const c of node.children) applyFilter(c);
      }
    };
    applyFilter(root);
  }
  return root;
}

/** Bottom-up aggregation of folder sizes and file counts. */
export function aggregateTree(node: FolderVizNode): void {
  if (!node.children || node.children.length === 0) {
    node.fileCount = node.isDirectory ? 0 : 1;
    return;
  }

  let totalSize = 0;
  let totalFiles = 0;
  for (const child of node.children) {
    aggregateTree(child);
    totalSize += child.size;
    totalFiles += child.fileCount;
  }
  node.size = totalSize;
  node.value = totalSize;
  node.fileCount = totalFiles;
}

/** Convert a FolderVizNode to ECharts tree/radial series data. */
export function toEChartsTree(
  node: FolderVizNode,
  options: {
    radial?: boolean;
    getColor?: (node: FolderVizNode) => string;
  } = {}
): any {
  const color = options.getColor?.(node);
  const result: any = {
    name: node.name,
    value: node.size,
    itemStyle: color ? { color } : undefined,
    path: node.path,
    isDirectory: node.isDirectory,
  };
  if (node.children && node.children.length > 0) {
    result.children = node.children.map((c) => toEChartsTree(c, options));
  }
  return result;
}

/** Convert a FolderVizNode to ECharts treemap series data. */
export function toEChartsTreemap(
  node: FolderVizNode,
  options: { getColor?: (node: FolderVizNode) => string } = {}
): any {
  const color = options.getColor?.(node);
  const result: any = {
    name: node.name,
    value: node.size,
    itemStyle: color ? { color } : undefined,
    path: node.path,
    isDirectory: node.isDirectory,
  };
  if (node.children && node.children.length > 0) {
    result.children = node.children.map((c) => toEChartsTreemap(c, options));
  }
  return result;
}

/** Convert a FolderVizNode to ECharts sunburst series data. */
export function toEChartsSunburst(
  node: FolderVizNode,
  options: { getColor?: (node: FolderVizNode) => string } = {}
): any {
  const color = options.getColor?.(node);
  const result: any = {
    name: node.name,
    value: node.size,
    itemStyle: color ? { color } : undefined,
    path: node.path,
    isDirectory: node.isDirectory,
  };
  if (node.children && node.children.length > 0) {
    result.children = node.children.map((c) => toEChartsSunburst(c, options));
  }
  return result;
}

/** Default color picker for FolderViz nodes.
 * Directories get a neutral folder color; files get a type-based color.
 * The caller can override by passing its own `getColor`. */
export function defaultNodeColor(node: FolderVizNode): string {
  if (node.isDirectory) return '#f4b400';
  const ext = baseNameOf(node.path).split('.').pop()?.toLowerCase() ?? '';
  const palette: Record<string, string> = {
    pdf: '#e57373',
    doc: '#64b5f6',
    docx: '#64b5f6',
    xls: '#81c784',
    xlsx: '#81c784',
    ppt: '#ffb74d',
    pptx: '#ffb74d',
    jpg: '#ba68c8',
    jpeg: '#ba68c8',
    png: '#ba68c8',
    gif: '#ba68c8',
    mp4: '#4dd0e1',
    mov: '#4dd0e1',
    txt: '#90a4ae',
    md: '#90a4ae',
  };
  return palette[ext] ?? '#bdbdbd';
}
