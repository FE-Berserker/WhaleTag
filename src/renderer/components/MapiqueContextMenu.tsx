import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import {
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
} from '@mui/material';
import type { TransitionProps } from '@mui/material/transitions';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import EditIcon from '@mui/icons-material/Edit';
import LocationOffIcon from '@mui/icons-material/LocationOff';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import AddLocationIcon from '@mui/icons-material/AddLocation';

import type { TFunction } from 'i18next';
import type { DirEntry } from '../../shared/ipc-types';

/**
 * H.26 P0-1: no-op MUI transition that still triggers the Popover
 * positioning lifecycle. MUI's default Fade / Grow transitions call
 * `reflow(node)` synchronously on enter, which throws in jsdom because
 * the portal target has no layout. We bypass that by not animating, but
 * we still forward `onEntering` so the Popover can compute its position
 * from `anchorPosition` synchronously on enter — otherwise the menu
 * flashes at (0,0) on the first right-click.
 *
 * Same pattern as KanbanEntryMenu's NoTransition.
 */
export const NoTransition = forwardRef<HTMLDivElement, TransitionProps>(
  function NoTransition(props, ref) {
    const { children, in: inProp, onEntering } = props;
    const localRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => localRef.current);
    // See KanbanEntryMenu.NoTransition for the full rationale — same
    // jsdom-skip pattern because MUI's MenuList.adjustStyleForScrollbar
    // dereferences listRef.current synchronously inside onEntering.
    useLayoutEffect(() => {
      if (!inProp || !localRef.current || !onEntering) return;
      // See KanbanEntryMenu.NoTransition for the full rationale.
      const w = typeof window !== 'undefined' ? window : undefined;
      const ua = w?.navigator?.userAgent ?? '';
      if (/jsdom/i.test(ua)) return;
      onEntering(localRef.current, false);
    }, [inProp, onEntering]);
    if (!inProp) return null;
    return (
      <div ref={localRef} data-testid="no-transition-mount">
        {children}
      </div>
    );
  }
);

/** H.26 P0-1: invisible Backdrop slot for jsdom safety. Renders a transparent
 * full-screen layer so MUI's Modal can still capture click-away events and
 * close the menu; returning null breaks that behavior.
 *
 * Same fix as KanbanEntryMenu.NoBackdrop: MUI's `Modal → useSlot('backdrop')`
 * passes `invisible` (a styling boolean — `true` when no dim is needed) and
 * `ownerState` (the Backdrop's style-state object) on top of the standard
 * `onClick` and `className`. Forwarding the first two to a plain `<div>`
 * produces the React warnings about `invisible` non-boolean + `ownerState`
 * unknown DOM attribute. Destructure them out before spreading `...rest`. */
export const NoBackdrop = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    open?: boolean;
    invisible?: boolean;
    ownerState?: unknown;
  }
>(function NoBackdrop(props, ref) {
  const {
    open,
    invisible: _invisible,
    ownerState: _ownerState,
    ...rest
  } = props;
  if (!open) return null;
  return (
    <div
      ref={ref}
      {...rest}
      data-testid="no-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'transparent',
      }}
    />
  );
});

export interface MapiqueContext {
  x: number;
  y: number;
  type: 'marker' | 'tray' | 'blank';
  entry?: DirEntry;
  lat?: number;
  lng?: number;
}

export interface MapiqueContextMenuProps {
  ctx: MapiqueContext | null;
  onClose: () => void;
  t: TFunction;
  onOpen?: (entry: DirEntry) => void;
  onReveal?: (entry: DirEntry) => void;
  onEditTags?: (entry: DirEntry) => void;
  onClearGeo?: (entry: DirEntry) => void;
  onCopyCoordinates?: (lat: number, lng: number) => void;
  /** Delete the right-clicked entry (trash or permanent per settings). */
  onDelete?: (entries: DirEntry[]) => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onCopyMap?: () => void;
  onSetLocationForSelection?: (lat: number, lng: number) => void;
  onClearLocationForSelection?: () => void;
  selectedCount: number;
  canEdit: boolean;
}

/**
 * H.26 P0-1: domain-aware context menu for the Mapique perspective. Handles
 * three surfaces:
 *   - marker right-click: file/location actions
 *   - tray row right-click: same file/location actions
 *   - blank map right-click: export + bulk location actions
 *
 * Does NOT reuse EntryContextMenu because Mapique needs location-domain
 * semantics (copy coordinates, clear location) rather than generic file ops.
 */
export default function MapiqueContextMenu({
  ctx,
  onClose,
  t,
  onOpen,
  onReveal,
  onEditTags,
  onClearGeo,
  onCopyCoordinates,
  onDelete,
  onSave,
  onSaveAs,
  onCopyMap,
  onSetLocationForSelection,
  onClearLocationForSelection,
  selectedCount,
  canEdit,
}: MapiqueContextMenuProps) {
  const entry = ctx?.entry;
  const isEntryMenu = ctx?.type === 'marker' || ctx?.type === 'tray';
  const isBlankMenu = ctx?.type === 'blank';
  const hasCoords = isEntryMenu && entry && ctx.lat !== undefined && ctx.lng !== undefined;

  return (
    <Menu
      open={ctx !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={ctx ? { top: ctx.y, left: ctx.x } : undefined}
      slots={{ transition: NoTransition, backdrop: NoBackdrop }}
      slotProps={{
        paper: { onContextMenu: (e: React.MouseEvent) => e.preventDefault() },
      }}
    >
      {isEntryMenu && entry && (
        <>
          <MenuItem
            onClick={() => {
              onOpen?.(entry);
              onClose();
            }}
            data-testid="mapique-menu-open"
          >
            <ListItemIcon>
              <OpenInNewIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('openFile')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onReveal?.(entry);
              onClose();
            }}
            data-testid="mapique-menu-reveal"
          >
            <ListItemIcon>
              <FolderOpenIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('revealInExplorer')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onEditTags?.(entry);
              onClose();
            }}
            data-testid="mapique-menu-edit-tags"
          >
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueEditTags')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onClearGeo?.(entry);
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-clear-location"
          >
            <ListItemIcon>
              <LocationOffIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('clearLocation')}</ListItemText>
          </MenuItem>

          {hasCoords && ctx.lat !== undefined && ctx.lng !== undefined && (
            <MenuItem
              onClick={() => {
                onCopyCoordinates?.(ctx.lat!, ctx.lng!);
                onClose();
              }}
              data-testid="mapique-menu-copy-coordinates"
            >
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('mapCopyCoords')}</ListItemText>
            </MenuItem>
          )}

          {/* Delete lives at the bottom of the entry branch, matching the
              Kanban/Gantt/Matrix domain menus; gated on canEdit like the
              other write actions. */}
          <MenuItem
            onClick={() => {
              onDelete?.([entry]);
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-delete"
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('delete')}</ListItemText>
          </MenuItem>
        </>
      )}

      {isBlankMenu && (
        <>
          <MenuItem
            onClick={() => {
              onSave?.();
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-save"
          >
            <ListItemIcon>
              <SaveIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('saveImage')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onSaveAs?.();
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-save-as"
          >
            <ListItemIcon>
              <DriveFileMoveIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('saveImageAs')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onCopyMap?.();
              onClose();
            }}
            data-testid="mapique-menu-copy-map"
          >
            <ListItemIcon>
              <PhotoLibraryIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueCopyMap')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              if (ctx.lat !== undefined && ctx.lng !== undefined) {
                onSetLocationForSelection?.(ctx.lat, ctx.lng);
              }
              onClose();
            }}
            disabled={!canEdit || selectedCount === 0}
            data-testid="mapique-menu-set-location-selection"
          >
            <ListItemIcon>
              <AddLocationIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueSetLocationForSelection')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onClearLocationForSelection?.();
              onClose();
            }}
            disabled={!canEdit || selectedCount === 0}
            data-testid="mapique-menu-clear-location-selection"
          >
            <ListItemIcon>
              <LocationOffIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueClearLocationForSelection')}</ListItemText>
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
