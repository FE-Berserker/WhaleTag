import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import {
  Box,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LaunchIcon from '@mui/icons-material/Launch';
import LabelOffOutlinedIcon from '@mui/icons-material/LabelOffOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import GestureIcon from '@mui/icons-material/Gesture';
import RefreshIcon from '@mui/icons-material/Refresh';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import ImageIcon from '@mui/icons-material/Image';
import WallpaperIcon from '@mui/icons-material/Wallpaper';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import HeadphonesIcon from '@mui/icons-material/Headphones';
import QueueMusicIcon from '@mui/icons-material/QueueMusic';

import type { DirEntry } from '../../shared/ipc-types';
import type { ExtensionManifest, ExtensionRegistry } from '../../shared/extension-types';
import type { TagGroup } from '../../shared/tag-library';
import type { RootState } from '-/reducers';
import { tagDisplayLabel } from '-/services/tag-display';
import { isAudioFile, isImageFile, isVideoFile } from '../../shared/whale-meta';
import { isPeriodTag } from '../../shared/smart-tags';
import { dateTagRangeKey } from '../../shared/calendar';
import { usePeriodTagDialog } from './PeriodTagDialog';
import { useTagMetaContext } from '-/hooks/TagMetaContextProvider';
import { useDirectoryContentContext } from '-/hooks/DirectoryContentContextProvider';
import { useBackgroundPlayer } from '-/hooks/BackgroundPlayerContextProvider';
import InlineTagInput from '-/components/InlineTagInput';
import {
  noTransitionMenuSlotProps,
  noTransitionMenuSlots,
} from './MenuNoTransition';

/**
 * Position payload for the right-click menu (parent gives us clientX/Y).
 */
export interface ContextMenuPosition {
  x: number;
  y: number;
  /** `null` ⇒ the user right-clicked the blank area below all rows. */
  entry: DirEntry | null;
}

/**
 * The full set of handlers + state the menu needs from FileList. Kept
 * flat (no nested action objects) to keep the call site readable —
 * every prop has one obvious source.
 *
 * H.23 P0-1: extracted verbatim from FileList.tsx's `<Menu>` blocks
 * (lines 1207-1617 + tag chip menu 1619-1646). The component owns no
 * state aside from `useTranslation`. All persistence/IO lives in
 * FileList through the supplied callbacks.
 */
export interface EntryContextMenuProps {
  // —— Context state ——
  ctx: ContextMenuPosition | null;
  /** Predicate: is the right-clicked entry part of a multi-selection we
   *  should act on as a bulk? FileList decides (selection state lives
   *  there). Reading it via predicate keeps the menu free of state. */
  isInBulkContext: (entry: DirEntry) => boolean;
  onClose: () => void;

  // —— Read-only + filesystem ——
  readOnly: boolean;
  tagsByName: Map<string, string[]>;
  thumbCacheClear: () => void;

  // —— Notice / error sink ——
  showError: (msg: string) => void;

  // —— Blank-area handlers ——
  setCreateKind: (k: 'folder' | 'file') => void;
  refresh: () => Promise<void>;
  revealCurrentDir: () => Promise<void> | void;
  newExcalidrawAvailable?: boolean;
  handleNewExcalidraw?: () => Promise<void> | void;
  newDrawioAvailable?: boolean;
  handleNewDrawio?: () => Promise<void> | void;

  // —— Bulk (multi-selection) handlers ——
  handleBulkMove: () => Promise<void> | void;
  handleBulkDelete: () => Promise<void> | void;
  /** Opens the package dialog. We don't fire the IO here — caller owns
   *  the dialog state and `handlePackageConfirm`. */
  openPackageDialog: () => void;
  /**
   * H.23 P3-1: flip every visible entry's selection. Items currently
   * selected get deselected; items not currently selected get selected.
   * Caller is `FileList`, which passes the current `visible` array.
   */
  onInvertSelection: () => void;

  // —— Single-entry handlers ——
  handleOpen: (entry: DirEntry) => void;
  openWithExtension: (
    entry: DirEntry,
    manifest: ExtensionManifest
  ) => Promise<void>;
  openNative: (path: string) => Promise<void>;
  setViewMode: (m: 'gallery') => void;
  revealEntry: (entry: DirEntry) => Promise<void> | void;
  /**
   * H.23 P1-7: copy the entry's absolute path to the OS clipboard via
   * `navigator.clipboard.writeText`. Caller wraps any permission-denied
   * fallback (older renderer without clipboard API, sandbox denied, etc.)
   * and surfaces via `showError`. The path that's copied is always an
   * OS-native absolute path (e.g. `/Users/foo/bar.md` or
   * `C:\Users\foo\bar.md`), so paste-into-Finder / paste-into-Terminal
   * works directly.
   */
  copyPath: (entry: DirEntry) => void;
  setFolderThumbnail: (entry: DirEntry) => Promise<void> | void;
  setFolderBackground: (entry: DirEntry) => Promise<void> | void;
  clearFolderThumbnail: (entry: DirEntry) => Promise<void> | void;
  clearFolderBackground: (entry: DirEntry) => Promise<void> | void;
  removeAllTags: (entry: DirEntry) => Promise<void> | void;
  /**
   * Per-entry tag add/remove for the inline "Edit tags" editor embedded in
   * the single-entry branch of this menu. Mirrors the call shape
   * `KanbanEntryMenu.onAddTag` / `onRemoveTag` use (parent owns any smart-tag
   * resolution + sidecar write). Not used in the bulk branch — bulk already
   * has its own "Remove all tags" item and per-file inline editing makes no
   * sense for a multi-selection.
   */
  onAddTag: (entry: DirEntry, tag: string) => void;
  onRemoveTag: (entry: DirEntry, tag: string) => void;
  setCopyTarget: (entry: DirEntry) => void;
  handleMove: (entry: DirEntry) => Promise<void> | void;
  setRenameTarget: (entry: DirEntry) => void;
  handleDelete: (entry: DirEntry) => Promise<void> | void;

  // —— Extension introspection (for "Open With" submenu) ——
  registry: ExtensionRegistry | null;
  userDefaults: Record<string, string>;
  enabledOverrides: Record<string, boolean>;
  getCompatibleExtensions: (
    entry: DirEntry,
    ctx: {
      registry: ExtensionRegistry | null;
      userDefaults: Record<string, string>;
      enabledOverrides: Record<string, boolean>;
    }
  ) => ExtensionManifest[];

  // Location-level shortcuts (set default / set task reminder / toggle
  // read-only) were removed from this menu (H.x P?); they live in the
  // Sidebar's per-location context menu instead, which is the canonical
  // surface for location-level configuration. No props needed here.
}

/**
 * The entry context menu (right-click on a row OR on the blank area below
 * all rows). Coordinates between blank-area / single-entry / bulk layouts
 * inside one `<Menu anchorPosition>`.
 *
 * H.23 P0-1: extracted from FileList.tsx. Read-only writes are uniformly
 * disabled via the single `readOnly` prop.
 */
export default function EntryContextMenu(props: EntryContextMenuProps) {
  const { t } = useTranslation();
  const backgroundPlayer = useBackgroundPlayer();
  const {
    ctx,
    isInBulkContext,
    onClose,
    readOnly,
    tagsByName,
    thumbCacheClear,
    showError,
    setCreateKind,
    refresh,
    revealCurrentDir,
    newExcalidrawAvailable,
    handleNewExcalidraw,
    newDrawioAvailable,
    handleNewDrawio,
    handleBulkMove,
    handleBulkDelete,
    openPackageDialog,
    onInvertSelection,
    handleOpen,
    openWithExtension,
    openNative,
    setViewMode,
    revealEntry,
    copyPath,
    setFolderThumbnail,
    setFolderBackground,
    clearFolderThumbnail,
    clearFolderBackground,
    removeAllTags,
    onAddTag,
    onRemoveTag,
    setCopyTarget,
    handleMove,
    setRenameTarget,
    handleDelete,
    registry,
    userDefaults,
    enabledOverrides,
    getCompatibleExtensions,
  } = props;
  // Tag-library state for the inline "Edit tags" editor embedded in the
  // single-entry branch. The parent already passes the directory's
  // `tagsByName` (used to render the row's chip strip), so we read color
  // and group tables straight from Redux — no need to plumb more props.
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? {}
  );
  const tagGroups = useSelector(
    (s: RootState): TagGroup[] => s.taglibrary?.groups ?? []
  );
  // Resolve the right-clicked entry's current tag list once, so the inline
  // editor and the "Remove all tags" disabled-state check agree. The parent
  // re-renders on every sidecar write (Redux refresh), so a chip removal
  // here flows back into `currentTags` on the next render.
  const ctxEntry = ctx?.entry ?? null;
  const currentTags = ctxEntry ? tagsByName.get(ctxEntry.path) ?? [] : [];

  return (
    <Menu
      open={ctx !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={
        ctx ? { top: ctx.y, left: ctx.x } : undefined
      }
      // H.27 P0-1: same no-op transition / backdrop as KanbanEntryMenu
      // (see MenuNoTransition.tsx for the jsdom `reflow` crash + (0,0)
      // flash rationale). Without this slot the menu crashes under
      // jsdom and may flash at (0,0) on the first right-click in prod.
      slotProps={{
        paper: { sx: { minWidth: 200 } },
        ...noTransitionMenuSlotProps,
      }}
      slots={noTransitionMenuSlots}
    >
      {ctx?.entry === null ? (
        // Blank-area menu
        <>
          <MenuItem
            disabled={readOnly}
            onClick={() => {
              setCreateKind('folder');
              onClose();
            }}
          >
            <ListItemIcon>
              <CreateNewFolderIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('newFolder')}</ListItemText>
          </MenuItem>
          <MenuItem
            disabled={readOnly}
            onClick={() => {
              setCreateKind('file');
              onClose();
            }}
          >
            <ListItemIcon>
              <NoteAddIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('newFile')}</ListItemText>
          </MenuItem>
          {newExcalidrawAvailable ? (
            <MenuItem
              disabled={readOnly}
              onClick={() => {
                void handleNewExcalidraw?.();
              }}
            >
              <ListItemIcon>
                <GestureIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('newExcalidraw')}</ListItemText>
            </MenuItem>
          ) : null}
          {newDrawioAvailable ? (
            <MenuItem
              disabled={readOnly}
              onClick={() => {
                void handleNewDrawio?.();
              }}
            >
              <ListItemIcon>
                <AccountTreeIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('newDrawio')}</ListItemText>
            </MenuItem>
          ) : null}
          <Divider />
          <MenuItem
            onClick={() => {
              void refresh();
              onClose();
            }}
          >
            <ListItemIcon>
              <RefreshIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('refresh')}</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => {
              try {
                void Promise.resolve(revealCurrentDir()).catch((e) =>
                  showError(e instanceof Error ? e.message : String(e))
                );
              } catch (e) {
                showError(e instanceof Error ? e.message : String(e));
              }
              onClose();
            }}
          >
            <ListItemIcon>
              <FolderOpenIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('revealInExplorer')}</ListItemText>
          </MenuItem>
        </>
      ) : ctx?.entry ? (
        (() => {
          const entry = ctx.entry;
          // If the right-clicked row is part of a multi-selection, act on
          // the whole selection (bulk); otherwise just this entry.
          const bulk = isInBulkContext(entry);
          if (bulk) {
            return (
              <>
                <MenuItem
                  disabled={readOnly}
                  onClick={() => {
                    void handleBulkMove();
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <DriveFileMoveIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('move')}</ListItemText>
                </MenuItem>
                <MenuItem
                  disabled={readOnly}
                  onClick={() => {
                    openPackageDialog();
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <FolderZipOutlinedIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('package')}</ListItemText>
                </MenuItem>
                <Divider />
                <MenuItem
                  disabled={readOnly}
                  onClick={() => {
                    void handleBulkDelete();
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <DeleteOutlineIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('delete')}</ListItemText>
                </MenuItem>
                <Divider />
                {/* H.23 P3-1: bulk "Invert selection" — flip every visible
                    row's selection. Scoped to `visible` so the user gets a
                    predictable "the rest of the directory" outcome. */}
                <MenuItem
                  onClick={() => {
                    onInvertSelection();
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <SwapHorizIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('invertSelection')}</ListItemText>
                </MenuItem>
              </>
            );
          }
          return (
            <>
              <MenuItem
                onClick={() => {
                  handleOpen(entry);
                  onClose();
                }}
              >
                <ListItemIcon>
                  <OpenInNewIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('open')}</ListItemText>
              </MenuItem>
              {/* Background-music dock: append this track to the queue
                  without opening a viewer. The dock at the bottom of the
                  window keeps playing across folder/view changes. */}
              {!entry.isDirectory && isAudioFile(entry.name) ? (
                <MenuItem
                  onClick={() => {
                    backgroundPlayer.playEntry(entry);
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <HeadphonesIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>后台播放</ListItemText>
                </MenuItem>
              ) : null}
              {entry.isFile ? (
                (() => {
                  const compatibleExts = getCompatibleExtensions(entry, {
                    registry,
                    userDefaults,
                    enabledOverrides,
                  });
                  if (compatibleExts.length === 0) return null;
                  return (
                    <>
                      <MenuItem
                        onClick={(e) => e.stopPropagation()}
                        sx={{ pl: 2 }}
                      >
                        <ListItemText sx={{ pl: 2 }}>
                          {t('openWith')}
                        </ListItemText>
                      </MenuItem>
                      {compatibleExts.map((ext) => (
                        <MenuItem
                          key={ext.id}
                          onClick={() => {
                            openWithExtension(entry, ext).catch(
                              (err: unknown) =>
                                showError(
                                  err instanceof Error
                                    ? err.message
                                    : String(err)
                                )
                            );
                            onClose();
                          }}
                          sx={{ pl: 4 }}
                        >
                          <Box
                            sx={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              backgroundColor: ext.color,
                              mr: 1,
                              flexShrink: 0,
                            }}
                          />
                          <ListItemText>{ext.name}</ListItemText>
                        </MenuItem>
                      ))}
                    </>
                  );
                })()
              ) : null}
              {entry.isFile ? (
                <MenuItem
                  onClick={() => {
                    openNative(entry.path).catch((e: unknown) =>
                      showError(e instanceof Error ? e.message : String(e))
                    );
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <LaunchIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('openWithDefaultApp')}</ListItemText>
                </MenuItem>
              ) : null}
              {entry.isFile &&
              (isImageFile(entry.name) || isVideoFile(entry.name)) ? (
                <MenuItem
                  onClick={() => {
                    setViewMode('gallery');
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <PhotoLibraryIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('openInGallery')}</ListItemText>
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() => {
                  try {
                    void Promise.resolve(revealEntry(entry)).catch((e) =>
                      showError(
                        e instanceof Error ? e.message : String(e)
                      )
                    );
                  } catch (e) {
                    showError(e instanceof Error ? e.message : String(e));
                  }
                  onClose();
                }}
              >
                <ListItemIcon>
                  <FolderOpenIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('revealInExplorer')}</ListItemText>
              </MenuItem>
              {entry.isFile || entry.isDirectory ? (
                <MenuItem
                  onClick={() => {
                    copyPath(entry);
                    onClose();
                  }}
                >
                  <ListItemIcon>
                    <ContentCopyIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('copyPath')}</ListItemText>
                </MenuItem>
              ) : null}
              {entry.isDirectory ? (
                <>
                  <Divider />
                  <MenuItem
                    disabled={readOnly}
                    onClick={() => {
                      const p = setFolderThumbnail(entry);
                      if (p && typeof (p as Promise<void>).then === 'function') {
                        (p as Promise<void>).then(thumbCacheClear);
                      }
                      onClose();
                    }}
                  >
                    <ListItemIcon>
                      <ImageIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t('setFolderThumbnail')}</ListItemText>
                  </MenuItem>
                  <MenuItem
                    disabled={readOnly}
                    onClick={() => {
                      void setFolderBackground(entry);
                      onClose();
                    }}
                  >
                    <ListItemIcon>
                      <WallpaperIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t('setFolderBackground')}</ListItemText>
                  </MenuItem>
                  <MenuItem
                    disabled={readOnly}
                    onClick={() => {
                      const p = clearFolderThumbnail(entry);
                      if (p && typeof (p as Promise<void>).then === 'function') {
                        (p as Promise<void>).then(thumbCacheClear);
                      }
                      onClose();
                    }}
                  >
                    <ListItemIcon>
                      <ImageIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t('clearFolderThumbnail')}</ListItemText>
                  </MenuItem>
                  <MenuItem
                    disabled={readOnly}
                    onClick={() => {
                      void clearFolderBackground(entry);
                      onClose();
                    }}
                  >
                    <ListItemIcon>
                      <WallpaperIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t('clearFolderBackground')}</ListItemText>
                  </MenuItem>
                </>
              ) : null}
              {/* Inline "Edit tags" editor — same affordance the Kanban
                  view's per-card menu uses (see KanbanEntryMenu.tsx
                  §"Section 4: Edit tags"). Stop click propagation so the
                  menu doesn't close while the user is typing into the
                  InlineTagInput. Read-only mode disables add/remove but
                  keeps the chips visible so the user can still see what
                  tags the entry carries. The bulk branch deliberately
                  omits this — per-file inline editing makes no sense for
                  a multi-selection (the bulk "Remove all tags" item
                  below is the symmetric counterpart). NOT shown on
                  Sidebar (locations) or DirectoryTree (tree folders) by
                  design — both are out of scope for this surface; tree
                  folders don't get sidecar writes from this path. */}
              <Box
                onClick={(e) => e.stopPropagation()}
                sx={{ px: 1.5, py: 1, minWidth: 280 }}
                data-testid="entry-edit-tags"
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ pl: 0.5, mb: 0.5, display: 'block' }}
                >
                  {t('kanbanEditTags')}
                </Typography>
                <InlineTagInput
                  tags={currentTags}
                  tagColors={tagColors}
                  groups={tagGroups}
                  t={t}
                  onAdd={(tag) => onAddTag(entry, tag)}
                  onRemove={(tag) => onRemoveTag(entry, tag)}
                  readOnly={readOnly}
                />
              </Box>
              <Divider />
              <MenuItem
                disabled={
                  readOnly ||
                  (tagsByName.get(entry.path) ?? []).length === 0
                }
                onClick={() => {
                  void removeAllTags(entry);
                  onClose();
                }}
              >
                <ListItemIcon>
                  <LabelOffOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('removeAllTags')}</ListItemText>
              </MenuItem>
              <Divider />
              <MenuItem
                disabled={readOnly}
                onClick={() => {
                  setCopyTarget(entry);
                  onClose();
                }}
              >
                <ListItemIcon>
                  <ContentCopyIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('copy')}</ListItemText>
              </MenuItem>
              <MenuItem
                disabled={readOnly}
                onClick={() => {
                  void handleMove(entry);
                  onClose();
                }}
              >
                <ListItemIcon>
                  <DriveFileMoveIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('move')}</ListItemText>
              </MenuItem>
              <MenuItem
                disabled={readOnly}
                onClick={() => {
                  setRenameTarget(entry);
                  onClose();
                }}
              >
                <ListItemIcon>
                  <EditIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('rename')}</ListItemText>
              </MenuItem>
              <Divider />
              <MenuItem
                disabled={readOnly}
                onClick={() => {
                  void handleDelete(entry);
                  onClose();
                }}
              >
                <ListItemIcon>
                  <DeleteOutlineIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('delete')}</ListItemText>
              </MenuItem>
              {/* The "Set as default / Set reminder / Toggle read-only"
                  shortcuts were removed from this menu (H.x P?) — they
                  belong to the *location* level, not the right-clicked
                  entry. The same three actions remain available via
                  Sidebar's per-location context menu (Sidebar.tsx), which
                  is the canonical surface for location-level configuration. */}
            </>
          );
        })()
      ) : null}
    </Menu>
  );
}

// Suppress unused-vars warnings on helpers only used in some menu branches.
void isImageFile;

/**
 * Per-tag context menu (right-click a row's tag chip → Remove tag).
 * Single-MenuItem dialog — kept tiny on purpose (the whole action is a
 * single confirm). Lives in the same file as `EntryContextMenu` because
 * they share the `t` + readOnly pattern and the parent's anchor-position
 * Menu machinery; the alternative (own file) costs more in boilerplate
 * than it saves in coupling.
 */
export interface TagChipContextMenuProps {
  ctx:
    | {
        x: number;
        y: number;
        entry: DirEntry;
        tag: string;
      }
    | null;
  readOnly: boolean;
  onClose: () => void;
  onRemoveTag: (entry: DirEntry, tag: string) => Promise<void> | void;
  /**
   * H.23 P2-5 bulk variant: when the right-clicked row's entry is part of
   * a multi-selection, also offer a one-click "Remove from N files" action.
   * The parent supplies the pre-filtered list of selected entries.
   */
  isInBulkContext?: (entry: DirEntry) => boolean;
  selectedEntries?: readonly DirEntry[];
  onRemoveTagFromMany?: (entries: DirEntry[], tag: string) => Promise<number> | void;
}

export function TagChipContextMenu(props: TagChipContextMenuProps) {
  const { t } = useTranslation();
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  // Edit-period flow needs to read the current tags + write a new meta —
  // both go through the shared tag / directory contexts, not through
  // the parent callbacks.
  const { save, saveMany } = useTagMetaContext();
  const { tagsByName, descByName, geoByName } = useDirectoryContentContext();
  const {
    ctx,
    readOnly,
    onClose,
    onRemoveTag,
    isInBulkContext,
    selectedEntries,
    onRemoveTagFromMany,
  } = props;
  const bulk = ctx ? !!isInBulkContext?.(ctx.entry) : false;
  return (
    <Menu
      open={ctx !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={ctx ? { top: ctx.y, left: ctx.x } : undefined}
    >
      {ctx ? (
        <>
          {/* Phase 5 / §8: edit a period tag's start + end dates. Only
              shown for tags whose shape is a period (YYYYMMDD-YYYYMMDD).
              Opens the same PeriodTagDialog used by drop, pre-filled with
              the current bounds; on confirm we replace the old token
              (remove + add) in a single write via `save()`. The互斥
              family rule guarantees only one period per file, so the
              remove + add pattern keeps invariant. Multi-select edit
              is left as a follow-up (would need a separate add-many
              primitive on `useListCommands`). */}
          {isPeriodTag(ctx.tag) ? (
            <MenuItem
              disabled={readOnly}
              data-testid="entry-context-edit-period"
              onClick={() => {
                const range = dateTagRangeKey(ctx.tag);
                if (!range) {
                  onClose();
                  return;
                }
                openPeriodDialog({
                  defaultStart: range.startKey,
                  defaultEnd: range.endKey,
                  onConfirm: async (newPeriod) => {
                    if (newPeriod === ctx.tag) {
                      // No change — just close.
                      return;
                    }
                    const oldTags = tagsByName.get(ctx.entry.path) ?? [];
                    // Drop the existing period token (the tag we
                    // right-clicked on) and append the new one. The互斥
                    // family rule is implicit here: a file carries at
                    // most one period, so after this write it's exactly
                    // the new token.
                    const nextTags = [
                      ...oldTags.filter((t) => t !== ctx.tag),
                      newPeriod,
                    ];
                    const existing = descByName.get(ctx.entry.path);
                    const existingGeo = geoByName.get(ctx.entry.path);
                    // save() requires the full SidecarMeta (desc / geo
                    // / tags). Re-use whatever the directory context
                    // already has so we don't clobber unrelated fields.
                    // `Parameters<typeof save>[1]` infers the type without
                    // pulling SidecarMeta into this module's imports.
                    const meta = {
                      tags: nextTags,
                      ...(existing !== undefined ? { description: existing } : {}),
                      ...(existingGeo ? { geo: existingGeo } : {}),
                    } as Parameters<typeof save>[1];
                    try {
                      await save(ctx.entry, meta);
                    } catch (err) {
                      // eslint-disable-next-line no-console
                      console.error(
                        '[edit-period] save failed for',
                        ctx.entry.path,
                        err
                      );
                    }
                  },
                });
                onClose();
              }}
            >
              <ListItemIcon>
                <EditIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>
                {t('editPeriodTag', {
                  defaultValue: 'Edit period dates',
                })}
              </ListItemText>
            </MenuItem>
          ) : null}
          {/* H.23 P2-5: single-entry removal (always present). */}
          <MenuItem
            disabled={readOnly}
            onClick={() => {
              void onRemoveTag(ctx.entry, ctx.tag);
              onClose();
            }}
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
            {t('removeTagNamed', {
              tag: tagDisplayLabel(ctx.tag, t),
            })}
          </ListItemText>
        </MenuItem>
        {/* H.23 P2-5: bulk removal — only when the right-clicked chip is on a
            row that's part of a multi-selection. We use `selectedEntries`
            (not just the right-clicked one) so the user sees exactly how
            many files will be affected. The bulk path uses
            `useListCommands.removeTagFromMany` (single saveMany round-trip). */}
        {bulk &&
        selectedEntries &&
        selectedEntries.length > 1 &&
        onRemoveTagFromMany ? (
          <MenuItem
            disabled={readOnly}
            onClick={() => {
              void onRemoveTagFromMany(
                selectedEntries as DirEntry[],
                ctx.tag
              );
              onClose();
            }}
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              {t('removeTagFromMany', {
                count: selectedEntries.length,
                tag: tagDisplayLabel(ctx.tag, t),
              })}
            </ListItemText>
          </MenuItem>
        ) : null}
        </>
      ) : null}
    </Menu>
  );
}
