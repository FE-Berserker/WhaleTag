import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import type { UserCommand } from '../../../shared/shell-types';
import { COMMAND_NOT_APPROVED, COMMAND_PATH_BLOCKED } from '../../../shared/shell-types';
import EntryContextMenu, {
  type EntryContextMenuProps,
} from '-/components/EntryContextMenu';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import type { ListCommands } from '-/hooks/useListCommands';
import { useNewDrawio } from '-/hooks/useNewDrawio';
import { useNewExcalidraw } from '-/hooks/useNewExcalidraw';
import { getCompatibleExtensions } from '-/services/extension-dispatch';
import { ipcApi } from '-/services/ipc-api';

/**
 * The file/folder right-click menu `FileList` renders (P2 FileList split).
 *
 * Ambient wiring (extension registry, current location, new-diagram
 * availability) is read from the same contexts `FileList` uses, so only the
 * state/sinks that live in `FileList` are passed in. All the handler bodies
 * below are verbatim copies of the inline props the JSX used to carry.
 */
export interface FileListEntryContextMenuProps {
  ctx: EntryContextMenuProps['ctx'];
  onClose: () => void;
  selectedEntries: DirEntry[];
  selectedPathsRef: MutableRefObject<Set<string>>;
  tagsByName: Map<string, string[]>;
  thumbCache: MutableRefObject<Map<string, string>>;
  showNotice: (
    text: string,
    severity?: 'success' | 'info' | 'warning' | 'error'
  ) => void;
  setCreateKind: (kind: 'folder' | 'file' | null) => void;
  setPackageOpen: (open: boolean) => void;
  setCopyTarget: (entry: DirEntry | null) => void;
  setRenameTarget: (entry: DirEntry | null) => void;
  refresh: () => Promise<void>;
  visible: DirEntry[];
  commands: ListCommands;
  handleOpen: (entry: DirEntry) => void;
  setViewMode: (mode: 'gallery') => void;
  onAddTag: (entry: DirEntry, tag: string) => void;
  onRemoveTag: (entry: DirEntry, tag: string) => void;
  onFolderBackgroundChange: () => void;
  userCommands: UserCommand[];
}

export default function FileListEntryContextMenu({
  ctx,
  onClose,
  selectedEntries,
  selectedPathsRef,
  tagsByName,
  thumbCache,
  showNotice,
  setCreateKind,
  setPackageOpen,
  setCopyTarget,
  setRenameTarget,
  refresh,
  visible,
  commands,
  handleOpen,
  setViewMode,
  onAddTag,
  onRemoveTag,
  onFolderBackgroundChange,
  userCommands,
}: FileListEntryContextMenuProps) {
  const { t } = useTranslation();
  const { currentLocation, currentDirectoryPath } = useCurrentLocationContext();
  const { openWithExtension, registry, userDefaults, enabledOverrides } =
    useExtensionContext();
  const { openNative } = useIOActionsContext();
  const newExcalidraw = useNewExcalidraw();
  const newDrawio = useNewDrawio();

  return (
    <EntryContextMenu
      ctx={ctx}
      isInBulkContext={(e) =>
        selectedPathsRef.current.has(e.path) && selectedEntries.length > 1
      }
      onClose={onClose}
      readOnly={!!currentLocation?.isReadOnly}
      tagsByName={tagsByName}
      thumbCacheClear={() => thumbCache.current.clear()}
      showError={(msg) => showNotice(msg)}
      setCreateKind={setCreateKind}
      refresh={refresh}
      revealCurrentDir={async () => {
        await ipcApi.revealPath(currentDirectoryPath);
      }}
      // H.23 P1-7: switch "Reveal in Explorer" to highlight + select the
      // file/folder in its parent (replaces the prior open-parent-only
      // behavior). The IPC layer (`shell:revealAndSelect`) handles the
      // platform branch internally.
      revealEntry={async (e) => {
        try {
          await ipcApi.revealAndSelect(e.path);
        } catch {
          // best-effort: reveal failure is non-fatal
        }
      }}
      // H.23 P1-7: copy absolute entry path to the OS clipboard. Some
      // sandboxed renderers deny `navigator.clipboard`; in that case
      // `showError` surfaces a localized message and the menu closes
      // so the user can retry / use the toolbar Copy-Past instead.
      copyPath={(e) => {
        if (!navigator.clipboard) {
          showNotice(t('clipboardUnavailable'));
          return;
        }
        navigator.clipboard.writeText(e.path).catch(() => {
          // Permission denied / sandbox rejected the write — surface the
          // same localized notice as the no-clipboard branch rather than
          // a raw English error string (H.23 P1-7 clipboard checklist).
          showNotice(t('clipboardUnavailable'));
        });
      }}
      newExcalidrawAvailable={newExcalidraw.available}
      handleNewExcalidraw={commands.handleNewExcalidraw}
      newDrawioAvailable={newDrawio.available}
      handleNewDrawio={commands.handleNewDrawio}
      handleBulkMove={commands.handleBulkMove}
      handleBulkDelete={commands.handleBulkDelete}
      openPackageDialog={() => setPackageOpen(true)}
      // H.23 P3-1: bulk "Invert selection" handler — flip every visible
      // row's selection through `commands.handleInvertSelection`.
      onInvertSelection={() => commands.handleInvertSelection(visible)}
      handleOpen={handleOpen}
      openWithExtension={openWithExtension}
      openNative={openNative}
      setViewMode={setViewMode}
      setFolderThumbnail={async (e) => {
        const src = await ipcApi.openImageFileDialog();
        if (!src) return;
        await ipcApi.setFolderThumbnail(e.path, src);
        thumbCache.current.clear();
        showNotice(t('folderThumbnailSet'), 'success');
      }}
      setFolderBackground={async (e) => {
        const src = await ipcApi.openImageFileDialog();
        if (!src) return;
        await ipcApi.setFolderBackground(e.path, src);
        if (e.path === currentDirectoryPath) onFolderBackgroundChange();
        showNotice(t('folderBackgroundSet'), 'success');
      }}
      clearFolderThumbnail={async (e) => {
        await ipcApi.clearFolderThumbnail(e.path);
        thumbCache.current.clear();
        showNotice(t('folderThumbnailCleared'), 'success');
      }}
      clearFolderBackground={async (e) => {
        await ipcApi.clearFolderBackground(e.path);
        if (e.path === currentDirectoryPath) onFolderBackgroundChange();
        showNotice(t('folderBackgroundCleared'), 'success');
      }}
      removeAllTags={commands.removeAllTags}
      // H.27 P0-1: inline "Edit tags" editor inside the file/folder
      // right-click menu (EntryContextMenu single-entry branch). Reuses
      // the same handlers that Kanban's per-card menu uses so the
      // smart-tag resolution + sidecar write behaviour stays consistent
      // across surfaces. Not surfaced on Sidebar (locations) or
      // DirectoryTree (tree folders) — both stay out of scope here.
      onAddTag={onAddTag}
      onRemoveTag={onRemoveTag}
      setCopyTarget={setCopyTarget}
      handleMove={commands.handleMove}
      setRenameTarget={setRenameTarget}
      handleDelete={commands.handleDelete}
      registry={registry}
      userDefaults={userDefaults}
      enabledOverrides={enabledOverrides}
      getCompatibleExtensions={getCompatibleExtensions}
      userCommands={userCommands}
      onRunCommand={(entry, cmd) => {
        ipcApi.runCommand(cmd.template, entry.path).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          // Main throws sentinels for the two user-visible refusals: an
          // unsubstitutable path (COMMAND_PATH_BLOCKED) and a template the
          // user has not approved yet (COMMAND_NOT_APPROVED). Map both to
          // localized text instead of showing the raw sentinel.
          showNotice(
            msg === COMMAND_PATH_BLOCKED
              ? t('commandPathBlocked')
              : msg === COMMAND_NOT_APPROVED
                ? t('commandNotApproved')
                : msg
          );
        });
      }}
    />
  );
}
