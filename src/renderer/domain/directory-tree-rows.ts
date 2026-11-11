import type { DirEntry } from '../../shared/ipc-types';

/** A flattened folder row in the virtualized tree. */
export interface TreeFolderNode {
  kind: 'folder';
  name: string;
  path: string;
  depth: number;
}

/** A flattened file row in the virtualized tree. */
export interface TreeFileNode {
  kind: 'file';
  entry: DirEntry;
  depth: number;
}

/**
 * A row under a folder whose children failed to load.
 *
 * The original bug: a rejected `listDirectory` was cached as an empty child
 * list, so the folder rendered as empty (and never retried). Representing the
 * failure as its own row keeps the folder "unloaded" and gives the UI a place
 * to offer Retry.
 */
export interface TreeErrorNode {
  kind: 'error';
  path: string;
  message: string;
  depth: number;
}

export type TreeNode = TreeFolderNode | TreeFileNode | TreeErrorNode;

export interface BuildTreeRowsInput {
  /** Display name of the root (the current location). */
  rootName: string;
  rootPath: string;
  expanded: ReadonlySet<string>;
  childrenByPath: ReadonlyMap<string, DirEntry[]>;
  childrenError: ReadonlyMap<string, string>;
  /** When false, only folders are emitted (files stay cached but hidden). */
  showFiles: boolean;
}

/**
 * Flatten the expanded subtree into the row list a virtualized list renders.
 *
 * An error row is emitted right after an expanded folder's children (or in
 * place of them when nothing was cached), so a failed load is visible and
 * retryable instead of looking like an empty folder.
 */
export function buildTreeRows(input: BuildTreeRowsInput): TreeNode[] {
  const { rootName, rootPath, expanded, childrenByPath, childrenError } = input;
  const out: TreeNode[] = [];
  const walk = (name: string, path: string, depth: number): void => {
    out.push({ kind: 'folder', name, path, depth });
    if (!expanded.has(path)) return;
    const kids = childrenByPath.get(path);
    if (kids) {
      const visibleKids = input.showFiles
        ? kids
        : kids.filter((k) => k.isDirectory);
      for (const k of visibleKids) {
        if (k.isDirectory) walk(k.name, k.path, depth + 1);
        else out.push({ kind: 'file', entry: k, depth: depth + 1 });
      }
    }
    const loadError = childrenError.get(path);
    if (loadError) {
      out.push({ kind: 'error', path, message: loadError, depth: depth + 1 });
    }
  };
  walk(rootName, rootPath, 0);
  return out;
}
