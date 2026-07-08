import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import {
  Alert,
  Box,
  CircularProgress,
  Divider,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Typography,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditIcon from '@mui/icons-material/Edit';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

import type { DirEntry } from '../../shared/ipc-types';
import { isAudioFile, isHiddenName } from '../../shared/whale-meta';
import { RootState } from '-/reducers';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useDirectoryContentContext } from '-/hooks/DirectoryContentContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useBackgroundPlayer } from '-/hooks/BackgroundPlayerContextProvider';
import { useDirectoryTreeRefresh } from '-/hooks/DirectoryTreeRefreshContextProvider';
import { ipcApi } from '-/services/ipc-api';
import { COLUMN_HEADER_HEIGHT } from '-/theme';
import { basename, joinPath } from '-/services/path-util';
import PromptDialog from '-/components/PromptDialog';

/** Normalizes separators + trailing slash so two spellings of a path compare equal. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The chain of folder paths from `root` down to (and including) `target`.
 * Returns just `[root]` when target is outside the root. Used to auto-expand
 * the tree so the current directory is always revealed.
 */
function ancestorChain(root: string, target: string): string[] {
  const nr = normPath(root);
  const nt = normPath(target);
  if (!nt.startsWith(nr)) return [root];
  const rel = nt.slice(nr.length).replace(/^\/+/, '');
  const chain = [root];
  let cur = root;
  for (const seg of rel.split('/').filter(Boolean)) {
    cur = joinPath(cur, seg);
    chain.push(cur);
  }
  return chain;
}

/**
 * Lazy folder tree for the active location. Folders load their children on
 * first expand; navigating elsewhere (file list, breadcrumb, back/forward)
 * auto-expands the ancestor chain so the current directory stays visible.
 */
export default function DirectoryTree() {
  const { t } = useTranslation();
  const { currentLocation, currentDirectoryPath, navigateTo } =
    useCurrentLocationContext();
  const { createFolder, createFile, deleteEntry } = useIOActionsContext();
  const { refresh } = useDirectoryContentContext();
  const backgroundPlayer = useBackgroundPlayer();
  // While an extension view (e.g. the Excalidraw editor) is open, also list
  // files in the tree so they can be dragged into it.
  const { activeView } = useExtensionContext();
  const showFiles = !!activeView;
  const showHiddenFiles = useSelector(
    (s: RootState) => s.settings?.showHiddenFiles ?? false
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Map<string, DirEntry[]>>(
    new Map()
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());
  // Dedupes load requests across the lazy-expand and reveal effects.
  const requestedRef = useRef<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  // Right-click on the empty area of the tree body (not on a folder row) —
  // surfaces a "New Folder" action that creates inside the current directory.
  const [emptyCtxMenu, setEmptyCtxMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Root container ref — used by the document-level contextmenu listener to
  // decide whether a right-click landed inside the tree (where the row /
  // empty-area `onContextMenu` handlers take over) or outside (where we need
  // to dismiss any open menu).
  const rootRef = useRef<HTMLDivElement | null>(null);

  // MUI <Menu> with anchorReference="anchorPosition" + a non-focusable Box
  // trigger loses its built-in click-away: focus never leaves the trigger, so
  // the internal focusout-based close never fires. Add a document-level
  // mousedown so a left-click anywhere outside the menu paper always closes it.
  useEffect(() => {
    if (emptyCtxMenu === null) return;
    const handleMouseDown = (e: MouseEvent) => {
      // Right-click is handled by onContextMenu (it re-opens / re-positions the
      // menu), middle-click is rare; only respond to left-click.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      setEmptyCtxMenu(null);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [emptyCtxMenu]);

  // Right-click outside the directory tree (e.g. on the location list / file
  // list / app bar) used to leave both the per-folder and empty-area menus
  // stuck open, because MUI's built-in close only fires on left-click
  // (backdrop) and Escape. Mirror the mousedown handler with a contextmenu
  // listener that closes both menus when the right-click lands outside the
  // tree root and outside the menu paper itself.
  useEffect(() => {
    if (ctxMenu === null && emptyCtxMenu === null) return;
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      if (rootRef.current && rootRef.current.contains(target)) return;
      setCtxMenu(null);
      setEmptyCtxMenu(null);
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, [ctxMenu, emptyCtxMenu]);
  const [createKind, setCreateKind] = useState<{
    kind: 'folder' | 'file';
    parent: string;
  } | null>(null);
  // Rename target (right-click a folder → Rename). Holds the path being renamed.
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  const loadChildren = useCallback(async (dirPath: string) => {
    if (requestedRef.current.has(dirPath)) return;
    requestedRef.current.add(dirPath);
    setLoading((prev) => new Set(prev).add(dirPath));
    try {
      const entries = await ipcApi.listDirectory(dirPath);
      // Store folders and files (folders first, each alphabetical). Files are
      // only rendered when an extension view is open (see showFiles); keeping
      // them cached means toggling that on/off needs no reload.
      const visible = entries
        .filter((e) => showHiddenFiles || !isHiddenName(e.name))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      setChildrenByPath((prev) => new Map(prev).set(dirPath, visible));
    } catch {
      // Mark as loaded-but-empty so we stop showing a spinner / expand affordance.
      setChildrenByPath((prev) => new Map(prev).set(dirPath, []));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  // Reset everything when the active location changes, then preload the root.
  useEffect(() => {
    requestedRef.current = new Set();
    setChildrenByPath(new Map());
    setLoading(new Set());
    if (currentLocation) {
      setExpanded(new Set([currentLocation.path]));
      void loadChildren(currentLocation.path);
    } else {
      setExpanded(new Set());
    }
  }, [currentLocation?.id, currentLocation?.path, loadChildren]);

  // Reveal the current directory: expand + load every ancestor folder.
  useEffect(() => {
    if (!currentLocation || !currentDirectoryPath) return;
    const chain = ancestorChain(currentLocation.path, currentDirectoryPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      chain.forEach((p) => next.add(p));
      return next;
    });
    chain.forEach((p) => void loadChildren(p));
  }, [currentLocation, currentDirectoryPath, loadChildren]);

  const toggle = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          void loadChildren(dirPath);
        }
        return next;
      });
    },
    [loadChildren]
  );

  // Force-reload a folder's children (after creating an entry inside it):
  // loadChildren dedupes via requestedRef, so clear the flag first.
  const reloadChildren = useCallback(
    (dirPath: string) => {
      requestedRef.current.delete(dirPath);
      void loadChildren(dirPath);
    },
    [loadChildren]
  );

  // Register the tree reload callback so IOActions can refresh the tree
  // after folder operations that originate outside the tree (file list, toolbar,
  // Kanban/Calendar context menus).
  const { registerRefreshTree, unregisterRefreshTree } = useDirectoryTreeRefresh();
  useEffect(() => {
    registerRefreshTree((dirPath) => reloadChildren(dirPath));
    return () => unregisterRefreshTree();
  }, [registerRefreshTree, unregisterRefreshTree, reloadChildren]);

  // Local transient notice for the copy-path action — DirectoryTree previously
  // had no notice surface (see the create-failure comment in handleCreate), so
  // we attach a small Snackbar at the tree root, scoped strictly to success /
  // failure of `handleCopyPath`.
  const [notice, setNotice] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);

  // Copy the entry's absolute path to the OS clipboard via
  // `navigator.clipboard.writeText`. Mirrors H.23 P1-7's FileList handler; we
  // wrap the promise so the local Snackbar can show success vs. failure on
  // the same render path. `ctxMenu.path` is always an OS-native absolute path
  // (e.g. `C:\Users\foo\bar.md` or `/home/foo/bar.md`), so paste-into-Finder /
  // paste-into-Terminal works directly.
  const handleCopyPath = (path: string) => {
    setCtxMenu(null);
    if (!navigator.clipboard) {
      setNotice({ kind: 'error', msg: t('clipboardUnavailable') });
      return;
    }
    navigator.clipboard.writeText(path).then(
      () => setNotice({ kind: 'success', msg: t('copyPathDone') }),
      () => setNotice({ kind: 'error', msg: t('clipboardUnavailable') })
    );
  };

  // Package a folder into a sibling `<dir>.zip`, then refresh the file list so
  // the new archive shows up in place (no jump to the OS file manager). The zip
  // lands next to the folder, i.e. in its parent — visible when that parent is
  // the directory currently open in the file list.
  const handlePackage = async (dirPath: string) => {
    try {
      await ipcApi.zipDirectory(dirPath);
      await refresh();
    } catch (e) {
      console.error('package failed:', e);
    }
  };

  // Delete a folder from the tree (to trash by default). Blocked for the
  // location root itself (remove the whole location via the sidebar instead),
  // and confirmed since deleting a folder is destructive. After trashing we
  // reload the parent's children so the node disappears from the tree.
  const handleDelete = async (dirPath: string) => {
    if (!currentLocation) return;
    if (normPath(dirPath) === normPath(currentLocation.path)) return;
    const name = basename(dirPath);
    if (!window.confirm(t('confirmDelete', { name }))) return;
    try {
      // Resolve the parent via IPC (canonical) — `childrenByPath` is keyed by
      // the exact canonical path, so `joinPath(dir, '..')` (a literal `..`)
      // would reload under the wrong key and the node wouldn't update.
      const parent = await ipcApi.parentDir(dirPath);
      await deleteEntry(dirPath);
      reloadChildren(parent);
    } catch (e) {
      console.error('delete failed:', e);
    }
  };

  // Rename a folder from the tree. Builds the new path in the folder's OWN
  // parent (not the file-list's current dir), renames via raw IPC, then reloads
  // the parent so the node shows its new name. Blocks the location root.
  const handleRenameConfirm = async (newName: string) => {
    const dirPath = renameTarget;
    setRenameTarget(null);
    if (!dirPath || !currentLocation) return;
    if (normPath(dirPath) === normPath(currentLocation.path)) return;
    if (newName === basename(dirPath)) return;
    try {
      const parent = await ipcApi.parentDir(dirPath);
      await ipcApi.rename(dirPath, joinPath(parent, newName));
      reloadChildren(parent);
    } catch (e) {
      console.error('rename failed:', e);
    }
  };

  // New folder/file from the tree's context menu, created inside `parent`.
  const handleCreate = async (name: string) => {
    const target = createKind;
    setCreateKind(null);
    if (!target || !name) return;
    try {
      if (target.kind === 'folder') await createFolder(name, target.parent);
      else await createFile(name, '', target.parent);
      // IOActionsContextProvider now refreshes the tree after folder creation;
      // files do not affect the directory tree.
    } catch (e) {
      // DirectoryTree has no notice area — log so failures aren't fully silent.
      console.error('create failed:', e);
    }
  };

  if (!currentLocation) return null;

  // Shared drag-start handler for files AND folders. Triggers a native OS drag
  // via `ipcApi.startFileDrag` (so the OS knows the dropped item is a real
  // file/folder) and dispatches a window CustomEvent with the metadata the
  // open extension needs — the sandboxed iframe can't read the dropped File's
  // path itself, so the host side supplies it via `whale:extdrag-start`.
  // We deliberately do NOT signal drag-end: starting a native OS drag fires
  // the element's HTML5 dragend immediately, which would clear the path before
  // the drop. The extension clears it on drop or via a safety timeout.
  const startEntryDrag = (entry: DirEntry) => (e: React.DragEvent) => {
    e.preventDefault();
    ipcApi.startFileDrag(entry.path);
    window.dispatchEvent(
      new CustomEvent('whale:extdrag-start', {
        detail: {
          path: entry.path,
          name: entry.name,
          isDirectory: !!entry.isDirectory,
        },
      })
    );
  };

  // Leaf node for a file (only shown while an extension view is open). Dragging
  // it starts a native OS drag so it can be dropped into the editor iframe.
  const renderFileNode = (entry: DirEntry, depth: number): ReactNode => (
    <ListItemButton
      key={entry.path}
      draggable
      onDragStart={startEntryDrag(entry)}
      // Right-click a file row opens the same `ctxMenu` the folder rows use,
      // so the new "Copy Path" item is available without a separate template.
      // `setEmptyCtxMenu(null)` mirrors `renderNode`'s handler to close any
      // empty-area menu that may be open when the user right-clicks.
      onContextMenu={(e) => {
        e.preventDefault();
        setEmptyCtxMenu(null);
        setCtxMenu({ x: e.clientX, y: e.clientY, path: entry.path });
      }}
      title={t('dragIntoEditor')}
      sx={{ pl: depth * 1.25 + 0.5, py: 0.25, minHeight: 28, cursor: 'grab' }}
    >
      <Box sx={{ width: 20, flexShrink: 0 }} />
      <InsertDriveFileOutlinedIcon
        fontSize="small"
        sx={{ mr: 0.75, flexShrink: 0, opacity: 0.7 }}
      />
      <ListItemText
        primary={entry.name}
        slotProps={{ primary: { noWrap: true, variant: 'body2' } }}
      />
    </ListItemButton>
  );

  const renderNode = (
    name: string,
    path: string,
    depth: number
  ): ReactNode => {
    const isExpanded = expanded.has(path);
    const isCurrent = normPath(path) === normPath(currentDirectoryPath);
    const kids = childrenByPath.get(path);
    // Folders always show; files only while an extension view is open.
    const visibleKids = kids
      ? showFiles
        ? kids
        : kids.filter((k) => k.isDirectory)
      : undefined;
    const isLoading = loading.has(path);
    // Hide the expand chevron only once we know there are no visible children.
    const hasToggle = !(visibleKids && visibleKids.length === 0);

    return (
      <Box key={path}>
        <ListItemButton
          data-tree-row="true"
          selected={isCurrent}
          draggable
          onDragStart={startEntryDrag({ path, name, isDirectory: true } as DirEntry)}
          onClick={() => {
            navigateTo(path);
            if (!isExpanded) toggle(path);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setEmptyCtxMenu(null); // close the empty-area menu if open
            setCtxMenu({ x: e.clientX, y: e.clientY, path });
          }}
          title={t('dragIntoEditor')}
          sx={{ pl: depth * 1.25 + 0.5, py: 0.25, minHeight: 32, cursor: 'grab' }}
        >
          <Box
            onClick={(e) => {
              e.stopPropagation();
              toggle(path);
            }}
            sx={{
              width: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {isLoading ? (
              <CircularProgress size={12} />
            ) : hasToggle ? (
              isExpanded ? (
                <ExpandMoreIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )
            ) : null}
          </Box>
          {/* Open-folder glyph marks the folder you're currently in (not every
              expanded folder), so it reverts when you navigate elsewhere. */}
          {isCurrent ? (
            <FolderOpenIcon fontSize="small" sx={{ mr: 0.75, flexShrink: 0 }} />
          ) : (
            <FolderIcon fontSize="small" sx={{ mr: 0.75, flexShrink: 0 }} />
          )}
          <ListItemText
            primary={name}
            slotProps={{
              primary: { noWrap: true, variant: 'body2' },
            }}
          />
        </ListItemButton>
        {isExpanded && visibleKids
          ? visibleKids.map((k) =>
              k.isDirectory
                ? renderNode(k.name, k.path, depth + 1)
                : renderFileNode(k, depth + 1)
            )
          : null}
      </Box>
    );
  };

  return (
    <Box
      ref={rootRef}
      sx={{
        width: 240,
        flexShrink: 0,
        borderRight: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          minHeight: COLUMN_HEADER_HEIGHT,
          px: 1.5,
          py: 0,
          flexShrink: 0,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Typography variant="overline" color="text.secondary">
          {t('folders')}
        </Typography>
      </Box>
      <Box
        sx={{ flex: 1, overflow: 'auto', py: 0.5 }}
        onContextMenu={(e) => {
          // Only fire on the empty area, not when the right-click lands on a
          // folder row (rows have their own context menu).
          if ((e.target as HTMLElement).closest('[data-tree-row]')) return;
          e.preventDefault();
          setCtxMenu(null); // close the per-folder menu if open
          setEmptyCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {renderNode(currentLocation.name, currentLocation.path, 0)}
      </Box>

      <Menu
        open={ctxMenu !== null}
        onClose={() => setCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined
        }
        slotProps={{ paper: { sx: { minWidth: 200 } } }}
      >
        {ctxMenu ? (
          <>
            <MenuItem
              onClick={() => {
                navigateTo(ctxMenu.path);
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <FolderOpenIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('open')}</ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => {
                // Read the directory off the main thread and feed any audio
                // entries to the background-music dock. We use listDirectory
                // (not the in-memory `entries`) because the user may have
                // right-clicked a folder they haven't navigated into yet.
                const dirPath = ctxMenu.path;
                setCtxMenu(null);
                ipcApi
                  .listDirectory(dirPath)
                  .then((children) => {
                    const audio = children.filter(
                      (c) => !c.isDirectory && isAudioFile(c.name)
                    );
                    if (audio.length === 0) return;
                    backgroundPlayer.playEntries(audio);
                  })
                  .catch(() => undefined);
              }}
            >
              <ListItemIcon>
                <PlayArrowIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>播放此文件夹</ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => {
                void ipcApi.revealPath(ctxMenu.path).catch(() => undefined);
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <OpenInNewIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('revealInExplorer')}</ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => handleCopyPath(ctxMenu.path)}
            >
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('copyPath')}</ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setCreateKind({ kind: 'folder', parent: ctxMenu.path });
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <CreateNewFolderIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('newFolder')}</ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setCreateKind({ kind: 'file', parent: ctxMenu.path });
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <NoteAddIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('newFile')}</ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                const dirPath = ctxMenu.path;
                setCtxMenu(null);
                void handlePackage(dirPath);
              }}
            >
              <ListItemIcon>
                <FolderZipOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('package')}</ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem
              disabled={
                !!currentLocation?.isReadOnly ||
                (!!currentLocation &&
                  normPath(ctxMenu.path) === normPath(currentLocation.path))
              }
              onClick={() => {
                setRenameTarget(ctxMenu.path);
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <EditIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('rename')}</ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem
              disabled={
                !!currentLocation?.isReadOnly ||
                (!!currentLocation &&
                  normPath(ctxMenu.path) === normPath(currentLocation.path))
              }
              onClick={() => {
                const dirPath = ctxMenu.path;
                setCtxMenu(null);
                void handleDelete(dirPath);
              }}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('delete')}</ListItemText>
            </MenuItem>
          </>
        ) : null}
      </Menu>

      <Menu
        open={emptyCtxMenu !== null}
        onClose={() => setEmptyCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          emptyCtxMenu
            ? { top: emptyCtxMenu.y, left: emptyCtxMenu.x }
            : undefined
        }
        slotProps={{ paper: { sx: { minWidth: 180 } } }}
      >
        <MenuItem
          disabled={!!currentLocation?.isReadOnly}
          onClick={() => {
            setEmptyCtxMenu(null);
            // Create inside the current directory (the same parent the user
            // would land in by clicking the location root, but without
            // having to aim at it).
            setCreateKind({
              kind: 'folder',
              parent: currentDirectoryPath,
            });
          }}
        >
          <ListItemIcon>
            <CreateNewFolderIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('newFolder')}</ListItemText>
        </MenuItem>
      </Menu>

      <PromptDialog
        open={createKind !== null}
        title={createKind?.kind === 'folder' ? t('newFolder') : t('newFile')}
        label={t('name')}
        onConfirm={handleCreate}
        onClose={() => setCreateKind(null)}
      />

      <PromptDialog
        open={renameTarget !== null}
        title={t('rename')}
        label={t('name')}
        defaultValue={renameTarget ? basename(renameTarget) : ''}
        onConfirm={handleRenameConfirm}
        onClose={() => setRenameTarget(null)}
      />

      {/* Snackbar: scoped to handleCopyPath's success/failure notice. Anchored
          bottom-left to sit just under the tree (which is fixed-width 240px on
          the window's left edge); other components (FileToolbar, FileList,
          etc.) keep their own anchor origins so multiple snackbars coexist. */}
      <Snackbar
        open={notice !== null}
        autoHideDuration={2500}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert
          severity={notice?.kind ?? 'success'}
          variant="filled"
          onClose={() => setNotice(null)}
        >
          {notice?.msg ?? ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
