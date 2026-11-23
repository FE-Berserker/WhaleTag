import type { DirEntry } from '../../shared/ipc-types';
import { isHiddenName } from '../../shared/whale-meta';

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
  /**
   * When false (the app default), dot-entries stay cached but are not emitted.
   *
   * P2-3: the cache used to be pre-filtered at `listDirectory` time, which made
   * the setting part of the loader's identity — toggling "show hidden files"
   * re-created `loadChildren` and wiped the whole tree (children + expansion)
   * to rescan from the root. Filtering at row-build time keeps the cache raw,
   * so the toggle is a pure re-render: expansion, scroll position and the
   * already-fetched children all survive.
   */
  showHiddenFiles?: boolean;
}

/**
 * The children of one folder as the tree should display them: files only when
 * `showFiles`, dot-entries only when `showHiddenFiles`. Single source of truth
 * shared by `buildTreeRows` (rows) and the folder row's chevron decision
 * (`children.length === 0`), so a folder holding only hidden entries doesn't
 * render an expand arrow that leads nowhere.
 */
export function visibleTreeChildren(
  kids: readonly DirEntry[],
  options: { showFiles: boolean; showHiddenFiles?: boolean }
): DirEntry[] {
  const showHidden = options.showHiddenFiles ?? false;
  return kids.filter(
    (k) =>
      (options.showFiles || k.isDirectory) &&
      (showHidden || !isHiddenName(k.name))
  );
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
      const visibleKids = visibleTreeChildren(kids, {
        showFiles: input.showFiles,
        showHiddenFiles: input.showHiddenFiles,
      });
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
